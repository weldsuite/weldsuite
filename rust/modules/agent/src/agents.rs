//! Workspace agents: CRUD, sub-agent checks and run persistence
//! (`packages/domains/agent/src/agents.ts`).

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;
use weldsuite_schema::tenant::weldagent_agent_runs as runs;
use weldsuite_schema::tenant::weldagent_agents::{self as agents, Column};

use crate::access::{AgentViewer, visible_to};

/// Most agents one agent can delegate to (`MAX_SUBAGENTS`).
pub const MAX_SUBAGENTS: usize = 19;

/// `DEFAULT_WORKSPACE_AGENT_MODEL` on Global and in conformance builds.
pub const GLOBAL_DEFAULT_MODEL: &str = "claude-opus-5-5";

/// `WORKSPACE_AGENT_MODELS`: the Claude ids Global's agents run on.
pub const GLOBAL_MODELS: [&str; 3] = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

/// The `modelId` an agent gets on the Kubernetes editions when nobody picked
/// one: it means "the workspace policy's model for the `agents` feature", and
/// [`crate::run`] resolves it per call.
pub const POLICY_DEFAULT_MODEL: &str = "default";

/// The `enabledTools` flag that turns on the automatic review of repeated
/// approvals.
pub const AUTO_REVIEW_FLAG: &str = "agent.auto_review";

/// `new Date()` as Drizzle writes a `timestamp with time zone` column: UTC,
/// to the millisecond (the instant [`crate::now`] prints).
pub(crate) fn now_tz() -> OffsetDateTime {
    let at = OffsetDateTime::now_utc();
    at.replace_millisecond(at.millisecond()).unwrap_or(at)
}

/// A row as the worker returns it: the entity serializes as Drizzle did.
pub(crate) fn js(model: impl serde::Serialize) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// `limit $n` of a number: Postgres refuses a negative one.
pub(crate) fn row_limit(limit: i64) -> Result<u64, DbErr> {
    u64::try_from(limit).map_err(|_| DbErr::Custom("LIMIT must not be negative".to_owned()))
}

/// `$n::int` of a number: Postgres refuses one that does not fit.
pub(crate) fn int4(value: i64) -> Result<i32, DbErr> {
    i32::try_from(value).map_err(|_| DbErr::Custom("integer out of range".to_owned()))
}

/// `serializeAgent(row)`.
fn serialize(agent: agents::Model) -> Value {
    serialize_row(&js(agent))
}

/// `serializeAgent` of the row as Drizzle returns it (camelCase keys).
fn serialize_row(row: &Value) -> Value {
    let enabled: Vec<String> = row
        .get("enabledTools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| t.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let pick = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let list = |key: &str| match row.get(key) {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        _ => json!([]),
    };
    json!({
        "id": pick("id"),
        "name": pick("name"),
        "description": pick("description"),
        "icon": pick("icon"),
        "status": pick("status"),
        "systemPrompt": pick("systemPrompt"),
        "modelId": pick("modelId"),
        "temperature": pick("temperature"),
        "maxTokens": pick("maxTokens"),
        "permissions": list("permissions"),
        "enabledTools": list("enabledTools"),
        "eventSubscriptions": list("eventSubscriptions"),
        "maxIterations": pick("maxIterations"),
        "maxTotalTokens": pick("maxTotalTokens"),
        "autoReviewEnabled": enabled.iter().any(|tool| tool == AUTO_REVIEW_FLAG),
        "createdBy": pick("createdBy"),
        "ownerId": pick("ownerId"),
        "visibility": pick("visibility"),
        "subagentIds": list("subagentIds"),
        "delegateToSelf": pick("delegateToSelf"),
        "totalRuns": pick("totalRuns"),
        "successfulRuns": pick("successfulRuns"),
        "failedRuns": pick("failedRuns"),
        "lastRunAt": pick("lastRunAt"),
        "lastRunStatus": pick("lastRunStatus"),
        "createdAt": pick("createdAt"),
        "updatedAt": pick("updatedAt"),
    })
}

/// `listAgents(db, status, viewer)`: the agents the viewer can see, newest
/// change first.
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_agents(
    db: &PgPool,
    status: Option<&str>,
    viewer: &AgentViewer,
) -> Result<Vec<Value>, DbErr> {
    let mut query = agents::Entity::find().filter(Column::DeletedAt.is_null());
    if let Some(status) = status {
        query = query.filter(Column::Status.eq(status));
    }
    if let Some(visible) = visible_to(viewer) {
        query = query.filter(visible);
    }
    Ok(query
        .order_by_desc(Column::UpdatedAt)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(serialize)
        .collect())
}

/// `getAgent(db, id)`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn get_agent(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    Ok(agents::Entity::find_by_id(id.to_owned())
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(serialize))
}

/// What `createAgent` takes.
#[derive(Debug, Default)]
pub struct CreateAgent {
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub system_prompt: Option<String>,
    pub model_id: Option<String>,
    pub temperature: Option<String>,
    pub max_tokens: Option<i64>,
    pub permissions: Vec<String>,
    pub enabled_tools: Option<Vec<String>>,
    pub event_subscriptions: Option<Vec<String>>,
    pub max_iterations: Option<i64>,
    pub max_total_tokens: Option<i64>,
    pub created_by: Option<String>,
    /// The model of an agent created without one (`DEFAULT_WORKSPACE_AGENT_MODEL`).
    pub default_model: String,
}

/// `createAgent(db, input)`: a draft agent, owned by its creator and visible
/// to the workspace.
///
/// # Errors
///
/// The tenant database fails.
pub async fn create_agent(db: &PgPool, input: CreateAgent) -> Result<Value, DbErr> {
    let id = generate_id("agt");
    let now = now_tz();
    agents::Entity::insert(agents::ActiveModel {
        id: Set(id.clone()),
        name: Set(input.name),
        description: Set(input.description),
        icon: Set(input.icon),
        status: Set("draft".to_owned()),
        system_prompt: Set(input.system_prompt.unwrap_or_default()),
        model_id: Set(input.model_id.unwrap_or(input.default_model)),
        temperature: Set(input.temperature.unwrap_or_else(|| "0.70".to_owned())),
        max_tokens: Set(int4(input.max_tokens.unwrap_or(2048))?),
        permissions: Set(json!(input.permissions)),
        enabled_tools: Set(json!(input.enabled_tools.unwrap_or_default())),
        event_subscriptions: Set(json!(input.event_subscriptions.unwrap_or_default())),
        max_iterations: Set(int4(input.max_iterations.unwrap_or(10))?),
        max_total_tokens: Set(int4(input.max_total_tokens.unwrap_or(20000))?),
        created_by: Set(input.created_by.clone()),
        owner_id: Set(input.created_by),
        visibility: Set("workspace".to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(get_agent(db, &id).await?.unwrap_or(Value::Null))
}

/// `UpdateAgentInput`: what an update changes. A nullable field set to
/// `Field::Null` clears it; `Field::Absent` leaves it.
#[derive(Debug, Default)]
pub struct UpdateAgent {
    pub name: Option<String>,
    pub description: Field<String>,
    pub icon: Field<String>,
    pub system_prompt: Option<String>,
    pub model_id: Option<String>,
    pub temperature: Option<String>,
    pub max_tokens: Option<i64>,
    pub permissions: Option<Vec<String>>,
    pub enabled_tools: Option<Vec<String>>,
    pub event_subscriptions: Option<Vec<String>>,
    pub max_iterations: Option<i64>,
    pub max_total_tokens: Option<i64>,
    pub status: Option<String>,
    /// Stores `agent.auto_review` in `enabledTools`.
    pub auto_review_enabled: Option<bool>,
    pub owner_id: Option<String>,
    pub visibility: Option<String>,
    pub subagent_ids: Option<Vec<String>>,
    pub delegate_to_self: Option<bool>,
}

/// `updateAgent(db, id, input)`; `None` when the agent does not exist.
///
/// # Errors
///
/// The tenant database fails.
pub async fn update_agent(
    db: &PgPool,
    id: &str,
    input: UpdateAgent,
) -> Result<Option<Value>, DbErr> {
    let Some(existing) = get_agent(db, id).await? else {
        return Ok(None);
    };
    let mut enabled: Option<Vec<String>> = input.enabled_tools;
    if let Some(on) = input.auto_review_enabled {
        let mut tools: Vec<String> = enabled.unwrap_or_else(|| {
            existing["enabledTools"]
                .as_array()
                .map(|t| {
                    t.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        });
        tools.retain(|tool| tool != AUTO_REVIEW_FLAG);
        if on {
            tools.push(AUTO_REVIEW_FLAG.to_owned());
        }
        enabled = Some(tools);
    }

    let mut update =
        agents::Entity::update_many().col_expr(Column::UpdatedAt, Expr::value(now_tz()));
    macro_rules! set {
        ($column:expr, $value:expr) => {
            if let Some(value) = $value {
                update = update.col_expr($column, Expr::value(value));
            }
        };
    }
    macro_rules! set_int {
        ($column:expr, $value:expr) => {
            if let Some(value) = $value {
                update = update.col_expr($column, Expr::value(int4(value)?));
            }
        };
    }
    macro_rules! set_json {
        ($column:expr, $value:expr) => {
            if let Some(value) = $value {
                update = update.col_expr($column, Expr::value(json!(value)));
            }
        };
    }
    macro_rules! set_nullable {
        ($column:expr, $field:expr) => {
            match $field {
                Field::Set(value) => {
                    update = update.col_expr($column, Expr::value(Some(value)));
                }
                Field::Null => {
                    update = update.col_expr($column, Expr::value(Option::<String>::None));
                }
                Field::Absent => {}
            }
        };
    }
    set!(Column::Name, input.name);
    set_nullable!(Column::Description, input.description);
    set_nullable!(Column::Icon, input.icon);
    set!(Column::SystemPrompt, input.system_prompt);
    set!(Column::ModelId, input.model_id);
    set!(Column::Temperature, input.temperature);
    set_int!(Column::MaxTokens, input.max_tokens);
    set_json!(Column::Permissions, input.permissions);
    set_json!(Column::EnabledTools, enabled);
    set_json!(Column::EventSubscriptions, input.event_subscriptions);
    set_int!(Column::MaxIterations, input.max_iterations);
    set_int!(Column::MaxTotalTokens, input.max_total_tokens);
    set!(Column::OwnerId, input.owner_id);
    set!(Column::Visibility, input.visibility);
    set_json!(Column::SubagentIds, input.subagent_ids);
    set!(Column::DelegateToSelf, input.delegate_to_self);
    set!(Column::Status, input.status);
    update.filter(Column::Id.eq(id)).exec(&orm(db)).await?;
    get_agent(db, id).await
}

/// `SubagentProblem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentProblem {
    SelfReference,
    TooMany { max: usize },
    NotFound { agent_id: String },
    DuplicateName { agent_name: String },
}

impl SubagentProblem {
    /// `subagentProblemMessage(problem)`.
    pub fn message(&self) -> String {
        match self {
            Self::SelfReference => {
                "An agent can't be its own sub-agent; use \"copies of itself\" instead".to_owned()
            }
            Self::TooMany { max } => format!("An agent can have at most {max} sub-agents"),
            Self::NotFound { agent_id } => format!("Sub-agent not found: {agent_id}"),
            Self::DuplicateName { agent_name } => {
                format!("Sub-agents need distinct names; \"{agent_name}\" is used twice")
            }
        }
    }
}

/// `checkSubagents(db, agent, subagentIds)`: a proposed sub-agent setup.
/// Delegation is one level deep, and names in the roster must be distinct (the
/// coordinator picks members by name).
///
/// # Errors
///
/// The tenant database fails.
pub async fn check_subagents(
    db: &PgPool,
    agent_id: &str,
    agent_name: &str,
    subagent_ids: &[String],
) -> Result<Option<SubagentProblem>, DbErr> {
    let mut ids: Vec<&String> = Vec::new();
    for id in subagent_ids {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.iter().any(|id| id.as_str() == agent_id) {
        return Ok(Some(SubagentProblem::SelfReference));
    }
    if ids.len() > MAX_SUBAGENTS {
        return Ok(Some(SubagentProblem::TooMany { max: MAX_SUBAGENTS }));
    }
    if ids.is_empty() {
        return Ok(None);
    }
    let rows: Vec<(String, String)> = agents::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Name])
        .filter(Column::Id.is_in(ids.iter().map(|id| id.as_str())))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    if let Some(missing) = ids
        .iter()
        .find(|id| !rows.iter().any(|(row_id, _)| row_id == **id))
    {
        return Ok(Some(SubagentProblem::NotFound {
            agent_id: (*missing).clone(),
        }));
    }
    let mut seen = vec![agent_name.trim().to_lowercase()];
    for (_, name) in &rows {
        let key = name.trim().to_lowercase();
        if seen.contains(&key) {
            return Ok(Some(SubagentProblem::DuplicateName {
                agent_name: name.clone(),
            }));
        }
        seen.push(key);
    }
    Ok(None)
}

/// `getSubagents(db, subagentIds)`: the sub-agents an agent may delegate to
/// (deleted ones dropped).
///
/// # Errors
///
/// The tenant database fails.
pub async fn get_subagents(db: &PgPool, subagent_ids: &[String]) -> Result<Vec<Value>, DbErr> {
    if subagent_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(agents::Entity::find()
        .filter(Column::Id.is_in(subagent_ids.iter().map(String::as_str)))
        .filter(Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?
        .into_iter()
        .map(serialize)
        .collect())
}

/// `deleteAgent(db, id)`: soft-delete. `false` when it does not exist.
///
/// # Errors
///
/// The tenant database fails.
pub async fn delete_agent(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    let now = now_tz();
    let result = agents::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .col_expr(Column::Status, Expr::value("paused"))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(result.rows_affected > 0)
}

/// `listAgentRuns(db, agentId, limit)`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_agent_runs(db: &PgPool, agent_id: &str, limit: i64) -> Result<Vec<Value>, DbErr> {
    Ok(runs::Entity::find()
        .filter(runs::Column::AgentId.eq(agent_id))
        .order_by_desc(runs::Column::CreatedAt)
        .limit(row_limit(limit)?)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(js)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_reads_a_row_like_serialize_agent() {
        let at = time::macros::datetime!(2026-11-13 10:00:00.123456 UTC);
        let agent = serialize(agents::Model {
            id: "agt_1".into(),
            name: "Triage".into(),
            description: None,
            icon: None,
            status: "draft".into(),
            system_prompt: String::new(),
            model_id: "claude-opus-5-5".into(),
            temperature: "0.70".into(),
            max_tokens: 2048,
            permissions: json!(["people:read"]),
            enabled_tools: json!(["agent.auto_review"]),
            event_subscriptions: json!([]),
            max_iterations: 10,
            max_total_tokens: 20000,
            created_by: Some("u1".into()),
            owner_id: Some("u1".into()),
            visibility: "workspace".into(),
            subagent_ids: json!([]),
            delegate_to_self: false,
            anthropic_agent_id: Some("ma_1".into()),
            anthropic_agent_version: None,
            anthropic_config_hash: None,
            anthropic_worker_agent_id: None,
            anthropic_worker_agent_version: None,
            anthropic_worker_config_hash: None,
            total_runs: 0,
            successful_runs: 0,
            failed_runs: 0,
            last_run_at: None,
            last_run_status: None,
            created_at: at,
            updated_at: at,
            deleted_at: None,
        });
        assert_eq!(agent["autoReviewEnabled"], true);
        assert_eq!(agent["systemPrompt"], "");
        assert_eq!(agent["createdAt"], "2026-11-13T10:00:00.123Z");
        assert_eq!(agent["subagentIds"], json!([]));
        assert!(agent.get("anthropicAgentId").is_none());
        assert!(agent.get("deletedAt").is_none());
    }

    #[test]
    fn subagent_problems_read_like_the_worker() {
        assert_eq!(
            SubagentProblem::TooMany { max: 19 }.message(),
            "An agent can have at most 19 sub-agents"
        );
        assert_eq!(
            SubagentProblem::NotFound {
                agent_id: "agt_9".into()
            }
            .message(),
            "Sub-agent not found: agt_9"
        );
    }
}
