//! Workspace agents: CRUD, sub-agent checks and run persistence
//! (`packages/domains/agent/src/agents.ts`).

use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, QueryBuilder};
use weldsuite_db::js_row;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;

use crate::access::{AgentViewer, visible_to_sql};

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

/// The columns `serializeAgent` reads, as JSON, camel-cased.
const AGENT_JSON: &str = "to_jsonb(a) - 'anthropic_agent_id' - 'anthropic_agent_version' \
    - 'anthropic_config_hash' - 'anthropic_worker_agent_id' - 'anthropic_worker_agent_version' \
    - 'anthropic_worker_config_hash' - 'deleted_at'";

/// `serializeAgent(row)`.
fn serialize(row: Value) -> Value {
    let row = js_row(row);
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
) -> Result<Vec<Value>, sqlx::Error> {
    let mut sql = format!("select {AGENT_JSON} from weldagent_agents a where a.deleted_at is null");
    if status.is_some() {
        sql.push_str(" and a.status = $2");
    }
    if let Some(visible) = visible_to_sql(viewer, "$1") {
        sql.push_str(" and ");
        sql.push_str(&visible);
    }
    sql.push_str(" order by a.updated_at desc");
    let mut query = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(sql)).bind(&viewer.user_id);
    if let Some(status) = status {
        query = query.bind(status);
    }
    Ok(query
        .fetch_all(db)
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
pub async fn get_agent(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let sql = format!(
        "select {AGENT_JSON} from weldagent_agents a where a.id = $1 and a.deleted_at is null"
    );
    Ok(sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
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
pub async fn create_agent(db: &PgPool, input: CreateAgent) -> Result<Value, sqlx::Error> {
    let id = generate_id("agt");
    let now = crate::now();
    sqlx::query(
        "insert into weldagent_agents
             (id, name, description, icon, status, system_prompt, model_id, temperature, max_tokens,
              permissions, enabled_tools, event_subscriptions, max_iterations, max_total_tokens,
              created_by, owner_id, visibility, created_at, updated_at)
         values ($1, $2, $3, $4, 'draft', $5, $6, $7, $8::int, $9::jsonb, $10::jsonb, $11::jsonb,
                 $12::int, $13::int, $14, $14, 'workspace', $15::timestamptz, $15::timestamptz)",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&input.description)
    .bind(&input.icon)
    .bind(input.system_prompt.unwrap_or_default())
    .bind(input.model_id.unwrap_or(input.default_model))
    .bind(input.temperature.unwrap_or_else(|| "0.70".to_owned()))
    .bind(input.max_tokens.unwrap_or(2048))
    .bind(json!(input.permissions))
    .bind(json!(input.enabled_tools.unwrap_or_default()))
    .bind(json!(input.event_subscriptions.unwrap_or_default()))
    .bind(input.max_iterations.unwrap_or(10))
    .bind(input.max_total_tokens.unwrap_or(20000))
    .bind(&input.created_by)
    .bind(&now)
    .execute(db)
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
) -> Result<Option<Value>, sqlx::Error> {
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

    let mut query: QueryBuilder<Postgres> =
        QueryBuilder::new("update weldagent_agents set updated_at = ");
    query.push_bind(crate::now()).push("::timestamptz");
    macro_rules! set {
        ($column:literal, $value:expr) => {
            if let Some(value) = $value {
                query.push(concat!(", ", $column, " = ")).push_bind(value);
            }
        };
    }
    macro_rules! set_int {
        ($column:literal, $value:expr) => {
            if let Some(value) = $value {
                query
                    .push(concat!(", ", $column, " = "))
                    .push_bind(value)
                    .push("::int");
            }
        };
    }
    macro_rules! set_json {
        ($column:literal, $value:expr) => {
            if let Some(value) = $value {
                query
                    .push(concat!(", ", $column, " = "))
                    .push_bind(json!(value))
                    .push("::jsonb");
            }
        };
    }
    macro_rules! set_nullable {
        ($column:literal, $field:expr) => {
            match $field {
                Field::Set(value) => {
                    query.push(concat!(", ", $column, " = ")).push_bind(value);
                }
                Field::Null => {
                    query.push(concat!(", ", $column, " = null"));
                }
                Field::Absent => {}
            }
        };
    }
    set!("name", input.name);
    set_nullable!("description", input.description);
    set_nullable!("icon", input.icon);
    set!("system_prompt", input.system_prompt);
    set!("model_id", input.model_id);
    set!("temperature", input.temperature);
    set_int!("max_tokens", input.max_tokens);
    set_json!("permissions", input.permissions);
    set_json!("enabled_tools", enabled);
    set_json!("event_subscriptions", input.event_subscriptions);
    set_int!("max_iterations", input.max_iterations);
    set_int!("max_total_tokens", input.max_total_tokens);
    set!("owner_id", input.owner_id);
    set!("visibility", input.visibility);
    set_json!("subagent_ids", input.subagent_ids);
    set!("delegate_to_self", input.delegate_to_self);
    set!("status", input.status);
    query.push(" where id = ").push_bind(id);
    query.build().execute(db).await?;
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
) -> Result<Option<SubagentProblem>, sqlx::Error> {
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
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select id, name from weldagent_agents where id = any($1) and deleted_at is null",
    )
    .bind(&ids)
    .fetch_all(db)
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
pub async fn get_subagents(
    db: &PgPool,
    subagent_ids: &[String],
) -> Result<Vec<Value>, sqlx::Error> {
    if subagent_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "select {AGENT_JSON} from weldagent_agents a where a.id = any($1) and a.deleted_at is null"
    );
    Ok(sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(sql))
        .bind(subagent_ids)
        .fetch_all(db)
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
pub async fn delete_agent(db: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "update weldagent_agents set deleted_at = $2::timestamptz, updated_at = $2::timestamptz, status = 'paused'
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(crate::now())
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// `listAgentRuns(db, agentId, limit)`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_agent_runs(
    db: &PgPool,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from weldagent_agent_runs r where r.agent_id = $1
         order by r.created_at desc limit $2",
    )
    .bind(agent_id)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_reads_a_row_like_serialize_agent() {
        let row = json!({
            "id": "agt_1", "name": "Triage", "description": null, "icon": null, "status": "draft",
            "system_prompt": "", "model_id": "claude-opus-5-5", "temperature": "0.70", "max_tokens": 2048,
            "permissions": ["people:read"], "enabled_tools": ["agent.auto_review"], "event_subscriptions": [],
            "max_iterations": 10, "max_total_tokens": 20000, "created_by": "u1", "owner_id": "u1",
            "visibility": "workspace", "subagent_ids": [], "delegate_to_self": false,
            "total_runs": 0, "successful_runs": 0, "failed_runs": 0, "last_run_at": null,
            "last_run_status": null, "created_at": "2026-11-13T10:00:00.123456+00:00",
            "updated_at": "2026-11-13T10:00:00.123456+00:00",
        });
        let agent = serialize(row);
        assert_eq!(agent["autoReviewEnabled"], true);
        assert_eq!(agent["systemPrompt"], "");
        assert_eq!(agent["createdAt"], "2026-11-13T10:00:00.123Z");
        assert_eq!(agent["subagentIds"], json!([]));
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
