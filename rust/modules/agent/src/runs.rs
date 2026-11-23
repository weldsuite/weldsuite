//! Run persistence (`packages/domains/agent/src/agents.ts`: `createAgentRun`,
//! `markRunRunning`, `completeAgentRun`, `findAgentsForEvent`). The agent loop
//! ([`crate::run`]) and the dispatchers write through these.

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::Value;
use sqlx::PgPool;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::weldagent_agent_runs::{self as runs, Column};
use weldsuite_schema::tenant::weldagent_agents as agents;

use crate::agents::{int4, list_agents, now_tz};

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
) -> Result<String, DbErr> {
    let id = generate_id("run");
    runs::Entity::insert(runs::ActiveModel {
        id: Set(id.clone()),
        agent_id: Set(agent_id.to_owned()),
        status: Set(status.unwrap_or("queued").to_owned()),
        trigger_type: Set(Some(trigger_type.to_owned())),
        trigger_data: Set(trigger_data.cloned()),
        created_at: Set(now_tz()),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(id)
}

/// `markRunRunning(db, runId)`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn mark_run_running(db: &PgPool, run_id: &str) -> Result<(), DbErr> {
    runs::Entity::update_many()
        .col_expr(Column::Status, Expr::value("running"))
        .col_expr(Column::StartedAt, Expr::value(now_tz()))
        .filter(Column::Id.eq(run_id))
        .exec(&orm(db))
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
/// counters. `durationMs` is the milliseconds since `startedAt` (`null`
/// before the run started), worked out by Postgres as the worker does.
///
/// # Errors
///
/// The tenant database fails.
pub async fn complete_agent_run(
    db: &PgPool,
    run_id: &str,
    agent_id: &str,
    done: RunCompletion,
) -> Result<(), DbErr> {
    use sea_orm::ExprTrait as _;
    let stamp = now_tz();
    let status = if done.success { "completed" } else { "failed" };
    let conn = orm(db);
    // extract(epoch from (completed_at - started_at)) * 1000, as an integer;
    // null while `started_at` is.
    let duration = Expr::from(
        Func::cust("date_part")
            .arg("epoch")
            .arg(Expr::value(stamp).sub(Expr::col(Column::StartedAt))),
    )
    .mul(1000)
    .cast_as("int");
    runs::Entity::update_many()
        .col_expr(Column::Status, Expr::value(status))
        .col_expr(Column::CompletedAt, Expr::value(stamp))
        .col_expr(Column::DurationMs, duration)
        .col_expr(Column::Result, Expr::value(done.result))
        .col_expr(Column::Error, Expr::value(done.error))
        .col_expr(
            Column::TotalIterations,
            Expr::value(int4(done.total_iterations)?),
        )
        .col_expr(
            Column::TotalTokensUsed,
            Expr::value(int4(done.total_tokens_used)?),
        )
        .col_expr(
            Column::ToolCallCount,
            Expr::value(int4(done.tool_call_count)?),
        )
        .filter(Column::Id.eq(run_id))
        .exec(&conn)
        .await?;
    let (succeeded, failed) = if done.success { (1, 0) } else { (0, 1) };
    agents::Entity::update_many()
        .col_expr(
            agents::Column::TotalRuns,
            Expr::col(agents::Column::TotalRuns).add(1),
        )
        .col_expr(
            agents::Column::SuccessfulRuns,
            Expr::col(agents::Column::SuccessfulRuns).add(succeeded),
        )
        .col_expr(
            agents::Column::FailedRuns,
            Expr::col(agents::Column::FailedRuns).add(failed),
        )
        .col_expr(agents::Column::LastRunAt, Expr::value(stamp))
        .col_expr(agents::Column::LastRunStatus, Expr::value(status))
        .col_expr(agents::Column::UpdatedAt, Expr::value(stamp))
        .filter(agents::Column::Id.eq(agent_id))
        .exec(&conn)
        .await?;
    Ok(())
}

/// `findAgentsForEvent(db, eventKey)`: active agents subscribed to an event
/// key (`person.created`) or to `*`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn find_agents_for_event(db: &PgPool, event_key: &str) -> Result<Vec<Value>, DbErr> {
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
) -> Result<bool, DbErr> {
    use sea_orm::ExprTrait as _;
    use sea_orm::sea_query::extension::postgres::PgExpr as _;
    let found: Option<String> = runs::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::AgentId.eq(agent_id))
        .filter(
            Expr::col(Column::TriggerData)
                .cast_json_field("eventId")
                .eq(event_id),
        )
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}
