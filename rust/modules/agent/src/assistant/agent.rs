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
use serde_json::Value;
use weldsuite_ai::Ai;

use crate::run::RunError;
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
    pub events: Option<EventSink>,
}

/// `runAgentOnce(args)`: the JSON the route answers in `data`
/// (`text`, `model`, `finishReason`, `usage`, `creditsUsed`,
/// `toolInvocations`).
///
/// # Errors
///
/// [`RunError::Unavailable`] until the loop serves it, or without `ai`.
pub async fn chat_once(ai: Option<&Ai>, chat: AgentChat) -> Result<Value, RunError> {
    let _ = (ai, chat);
    // SEAM (WeldAgent loop): one turn of the agent, no conversation row.
    Err(RunError::Unavailable)
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
    let _ = (ai, chat);
    // SEAM (WeldAgent loop): the streamed turn.
    Err(RunError::Unavailable)
}
