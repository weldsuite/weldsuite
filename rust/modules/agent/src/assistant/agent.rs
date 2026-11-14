//! `/api/ai/chat` and `/api/ai/chat/stream` with an `agentId`: a workspace
//! agent's turn, answered without a stored conversation
//! (`runAgentOnce` / `streamAgentChat` in `packages/domains/agent/src/executor.ts`).
//!
//! The access checks (`loadWorkspaceAgent`) are here. The loop itself belongs
//! to WeldAgent ([`crate::run`]); these two functions are the seam to it, and
//! answer what the worker answers without its model (503 `ai_unavailable`)
//! until the loop serves them. The assistant's own routes never call them
//! for the default persona.

use axum::body::Bytes;
use futures_util::stream::BoxStream;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use weldsuite_ai::{Ai, Role};

use crate::agent_loop::{
    ChatMsg, TurnInput, assert_credits, build_system, run_turn, stream_turn, tools_for,
};
use crate::agents::GLOBAL_MODELS;
use crate::run::{RunEnv, RunError, has_sandbox_tools, tool_context};
use crate::tools::EventSink;

/// `buildAgentRunArgs`: what one agent turn is run with.
#[derive(Debug, Clone)]
pub struct AgentChat {
    pub db: sqlx::PgPool,
    pub workspace_id: String,
    pub actor_user_id: String,
    /// The agent row, as [`crate::agents::get_agent`] reads it.
    pub agent: Value,
    /// The conversation so far: `(role, content)` of the user and assistant
    /// turns, record tags spelled out.
    pub messages: Vec<(String, String)>,
    /// The caller's `model` (honoured when it is a model the agents offer),
    /// `temperature` and `maxTokens`.
    pub model: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    pub extra_system: Option<String>,
    pub actor_permissions: Vec<String>,
    pub env: RunEnv,
    pub events: Option<EventSink>,
}

/// What `buildAgentRunArgs` does to the agent row: the caller's model (when it
/// is one the agents offer), temperature and token limit replace the agent's
/// own for this turn.
fn agent_for_turn(chat: &AgentChat) -> Value {
    let mut agent = chat.agent.clone();
    if let Some(map) = agent.as_object_mut() {
        if let Some(model) = chat
            .model
            .as_deref()
            .filter(|m| chat.env.sandbox && GLOBAL_MODELS.contains(m))
        {
            map.insert("modelId".into(), json!(model));
        }
        if let Some(temperature) = chat.temperature {
            map.insert("temperature".into(), json!(temperature.to_string()));
        }
        if let Some(max_tokens) = chat.max_tokens {
            map.insert("maxTokens".into(), json!(max_tokens));
        }
    }
    agent
}

fn history(messages: &[(String, String)]) -> Vec<ChatMsg> {
    messages
        .iter()
        .filter_map(|(role, content)| {
            let role = match role.as_str() {
                "user" => Role::User,
                "assistant" => Role::Assistant,
                _ => return None,
            };
            Some(ChatMsg {
                role,
                content: content.clone(),
            })
        })
        .collect()
}

/// The turn's inputs: the agent as this call runs it, its tool context,
/// system prompt, tools and history.
struct Prepared {
    agent: Value,
    ctx: crate::tools::ToolContext,
    system: String,
    history: Vec<ChatMsg>,
    tools: Vec<&'static crate::tools::ToolSpec>,
    reference: String,
    sandbox: Option<crate::tools::SandboxAccess>,
}

async fn prepare(ai: &Ai, chat: &AgentChat) -> Prepared {
    let agent = agent_for_turn(chat);
    let ctx = tool_context(
        &agent,
        &chat.env,
        Some(ai),
        &chat.db,
        &chat.workspace_id,
        &chat.actor_user_id,
        Some(chat.actor_permissions.clone()),
        chat.events.clone(),
    );
    let history = history(&chat.messages);
    let user_turns = history.iter().filter(|m| m.role == Role::User).count();
    let session = agent["id"].as_str().unwrap_or_default().to_owned();
    let sandbox = crate::run::turn_sandbox(&chat.env, ai, &agent, &ctx, &session).await;
    let tools = crate::agent_loop::with_sandbox_tools(
        &agent,
        &ctx,
        sandbox.as_ref(),
        tools_for(&agent, &ctx, user_turns),
    );
    let system = build_system(
        &chat.db,
        &agent,
        has_sandbox_tools(&tools),
        chat.extra_system.as_deref(),
    )
    .await;
    let reference = agent["id"].as_str().unwrap_or_default().to_owned();
    Prepared {
        agent,
        ctx,
        system,
        history: crate::agent_loop::trim_history(history),
        tools,
        reference,
        sandbox,
    }
}

/// `runAgentOnce(args)`: the JSON the route answers in `data`
/// (`text`, `model`, `finishReason`, `usage`, `creditsUsed`,
/// `toolInvocations`).
///
/// # Errors
///
/// [`RunError::Unavailable`] until the loop serves it, or without `ai`.
pub async fn chat_once(ai: Option<&Ai>, chat: AgentChat) -> Result<Value, RunError> {
    let Some(ai) = ai.filter(|ai| ai.enabled()) else {
        return Err(RunError::Unavailable);
    };
    let p = prepare(ai, &chat).await;
    let done = run_turn(TurnInput {
        ai,
        agent: &p.agent,
        ctx: &p.ctx,
        system: p.system,
        history: p.history,
        tools: p.tools,
        skip_approvals: false,
        reference: p.reference,
        sandbox: p.sandbox,
    })
    .await
    .map_err(RunError::Ai)?;
    let model = done
        .meta
        .as_ref()
        .and_then(|m| m["model"].as_str())
        .or_else(|| p.agent["modelId"].as_str())
        .unwrap_or_default()
        .to_owned();
    Ok(json!({
        "text": done.text,
        "model": model,
        "finishReason": done.finish_reason.unwrap_or_else(|| json!("stop")),
        "usage": { "inputTokens": done.input_tokens, "outputTokens": done.output_tokens },
        "creditsUsed": done.credits,
        "toolInvocations": done.invocations,
    }))
}

/// `streamAgentChat(args)`: the agent's reply as the plain text the chat
/// client reads.
///
/// # Errors
///
/// [`RunError::Unavailable`] until the loop serves it, or without `ai`.
pub async fn chat_stream(
    ai: Option<&Ai>,
    chat: AgentChat,
) -> Result<BoxStream<'static, Result<Bytes, std::io::Error>>, RunError> {
    let Some(ai) = ai.filter(|ai| ai.enabled()).cloned() else {
        return Err(RunError::Unavailable);
    };
    let p = prepare(&ai, &chat).await;
    // The 402 gate before the stream opens: a refusal is an answer, not a stream.
    assert_credits(&ai, &p.agent, &p.ctx, &p.reference)
        .await
        .map_err(RunError::Ai)?;
    let (out, rx) = mpsc::channel::<String>(32);
    tokio::spawn(async move {
        stream_turn(
            TurnInput {
                ai: &ai,
                agent: &p.agent,
                ctx: &p.ctx,
                system: p.system.clone(),
                history: p.history.clone(),
                tools: p.tools.clone(),
                skip_approvals: false,
                reference: p.reference.clone(),
                sandbox: p.sandbox.clone(),
            },
            out,
        )
        .await;
    });
    Ok(Box::pin(futures_util::stream::unfold(
        rx,
        |mut rx| async move { rx.recv().await.map(|text| (Ok(Bytes::from(text)), rx)) },
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(env: RunEnv) -> AgentChat {
        AgentChat {
            db: sqlx::PgPool::connect_lazy("postgres://localhost/none").unwrap(),
            workspace_id: "ws_1".into(),
            actor_user_id: "u1".into(),
            agent: json!({ "id": "agt_1", "modelId": "claude-opus-5-5", "maxTokens": 100 }),
            messages: vec![
                ("system".into(), "ignored".into()),
                ("user".into(), "hi".into()),
            ],
            model: Some("claude-haiku-5-5".into()),
            temperature: Some(0.5),
            max_tokens: Some(50),
            extra_system: None,
            actor_permissions: Vec::new(),
            env,
            events: None,
        }
    }

    #[tokio::test]
    async fn the_callers_model_and_limits_replace_the_agents() {
        let global = RunEnv {
            sandbox: true,
            ..RunEnv::default()
        };
        let agent = agent_for_turn(&chat(global));
        assert_eq!(agent["modelId"], "claude-haiku-5-5");
        assert_eq!(agent["temperature"], "0.5");
        assert_eq!(agent["maxTokens"], 50);
        // Not an agent model here: the agent keeps its own.
        let agent = agent_for_turn(&chat(RunEnv::default()));
        assert_eq!(agent["modelId"], "claude-opus-5-5");
    }

    #[tokio::test]
    async fn only_user_and_assistant_turns_reach_the_model() {
        assert_eq!(history(&chat(RunEnv::default()).messages).len(), 1);
    }

    #[tokio::test]
    async fn without_a_model_both_answer_unavailable() {
        assert!(matches!(
            chat_once(None, chat(RunEnv::default())).await,
            Err(RunError::Unavailable)
        ));
        assert!(matches!(
            chat_stream(None, chat(RunEnv::default())).await,
            Err(RunError::Unavailable)
        ));
    }
}
