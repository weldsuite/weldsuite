//! The seam to the agent loop (`packages/domains/agent/src/run.ts`
//! `executeAgentRun`, `complete-turn.ts` `completeConversationTurn`).
//!
//! Everything that would call the model goes through [`run_agent`] (a manual
//! run, an event, a routine, a room reply) or [`agent_turn`] (a chat turn).
//! They are the one place the loop over [`weldsuite_ai`] plugs in. Until it is
//! filled in they answer what the worker answers without its model: 503
//! `ai_unavailable`, "AI is currently unavailable".
//!
//! The loop, when it lands, is described in `docs/plans/eu-ai-mistral.md`
//! ("Phase 5"): build the request (instructions, conversation, the tools of
//! [`crate::tools::resolve_agent_tools`]), `ai.chat` with `Feature::Agents`,
//! run each tool call through [`crate::tools::execute_tool`], stop at
//! `maxIterations` or `maxTotalTokens`, one charge per model call.

use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use weldsuite_ai::{Ai, AiError};
use weldsuite_kit::ApiError;

use crate::tools::EventSink;

/// How a run started (`triggerType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerType {
    Manual,
    Event,
    Chat,
}

impl TriggerType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Event => "event",
            Self::Chat => "chat",
        }
    }
}

/// `executeAgentRun`'s params.
#[derive(Debug, Clone)]
pub struct RunParams {
    pub db: PgPool,
    pub workspace_id: String,
    pub actor_user_id: String,
    pub agent_id: String,
    pub trigger_type: TriggerType,
    pub trigger_data: Option<Value>,
    pub user_message: String,
    pub extra_system: Option<String>,
    /// Reuse an existing queued run id.
    pub run_id: Option<String>,
    /// The routine run row this run belongs to, when a routine started it.
    pub routine_run_id: Option<String>,
    /// A routine with "ask for approval" turned off acts without parking
    /// approvals.
    pub skip_approvals: bool,
    /// `false` when the caller notifies on its own (routine runs post into a
    /// chat thread).
    pub notify: bool,
    /// The driving person's permissions; `None` for unattended runs.
    pub actor_permissions: Option<Vec<String>>,
    pub events: Option<EventSink>,
}

/// `{ runId, text, success, error? }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutcome {
    pub run_id: String,
    pub text: String,
    pub success: bool,
    pub error: Option<String>,
}

impl RunOutcome {
    pub fn to_json(&self) -> Value {
        let mut out =
            serde_json::json!({ "runId": self.run_id, "text": self.text, "success": self.success });
        if let (Some(error), Some(map)) = (&self.error, out.as_object_mut()) {
            map.insert("error".into(), Value::String(error.clone()));
        }
        out
    }
}

/// `completeConversationTurn`'s params.
#[derive(Debug, Clone)]
pub struct TurnParams {
    pub db: PgPool,
    pub workspace_id: String,
    pub user_id: String,
    pub conversation_id: String,
    pub content: String,
    /// Overrides the conversation's bound agent for this turn.
    pub agent_id: Option<String>,
    pub actor_permissions: Vec<String>,
    pub timezone: Option<String>,
    /// Block until the reply is persisted.
    pub wait: bool,
    pub events: Option<EventSink>,
}

/// Why the loop did not answer.
#[derive(Debug)]
pub enum RunError {
    /// No model (no provider configured, or the loop is not wired in yet).
    Unavailable,
    /// The model call failed or was refused (the 402 gate included).
    Ai(AiError),
    /// The agent is gone, or the caller lost access to it.
    NotFound(String),
    Failed(String),
}

impl RunError {
    /// The response a route gives: 503 `ai_unavailable` without a model, the
    /// AI layer's own answer for a refusal (`AiError::into_api_error`).
    pub fn into_response_for(self, fallback: &'static str) -> Response {
        match self {
            Self::Unavailable => unavailable(),
            Self::Ai(error) => error.into_api_error().into_response(),
            Self::NotFound(what) => ApiError::not_found(&what, None).into_response(),
            Self::Failed(message) => {
                tracing::error!(%message, "[agent-api] {fallback}");
                ApiError::internal().with_message(message).into_response()
            }
        }
    }
}

/// 503 `ai_unavailable`, "AI is currently unavailable": what agent-api's
/// stubbed AI routes answer.
pub fn unavailable() -> Response {
    (
        http::StatusCode::SERVICE_UNAVAILABLE,
        axum::Json(serde_json::json!({
            "error": { "code": "ai_unavailable", "message": "AI is currently unavailable" }
        })),
    )
        .into_response()
}

/// `executeAgentRun(params)`: run an agent once (manual, event, routine, room
/// reply), persist the run and notify.
///
/// # Errors
///
/// [`RunError::Unavailable`] until the loop is filled in, or when `ai` is
/// `None`.
pub async fn run_agent(ai: Option<&Ai>, params: RunParams) -> Result<RunOutcome, RunError> {
    let _ = (ai, params);
    // SEAM (part 2): create the run row, run the loop, complete the run row.
    Err(RunError::Unavailable)
}

/// `completeConversationTurn(params)`: one chat turn (the user's message is
/// saved, the reply generated and saved). Returns the turn's result JSON
/// (`CompleteTurnResult`).
///
/// # Errors
///
/// [`RunError::Unavailable`] until the loop is filled in, or when `ai` is
/// `None`.
pub async fn agent_turn(ai: Option<&Ai>, params: TurnParams) -> Result<Value, RunError> {
    let _ = (ai, params);
    // SEAM (part 2): the conversation-backed turn and the assistant chat.
    Err(RunError::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn without_a_model_the_seam_says_so() {
        let db = PgPool::connect_lazy("postgres://localhost/none").unwrap();
        let params = RunParams {
            db,
            workspace_id: "ws_1".into(),
            actor_user_id: "u1".into(),
            agent_id: "agt_1".into(),
            trigger_type: TriggerType::Manual,
            trigger_data: None,
            user_message: "go".into(),
            extra_system: None,
            run_id: None,
            routine_run_id: None,
            skip_approvals: false,
            notify: true,
            actor_permissions: None,
            events: None,
        };
        assert!(matches!(
            run_agent(None, params).await,
            Err(RunError::Unavailable)
        ));
    }

    #[test]
    fn the_unavailable_answer_is_the_workers() {
        let response = unavailable();
        assert_eq!(response.status(), http::StatusCode::SERVICE_UNAVAILABLE);
    }
}
