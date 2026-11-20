//! Running an agent once, and one chat turn (`packages/domains/agent/src/run.ts`
//! `executeAgentRun`, `complete-turn.ts` `completeConversationTurn`), over the
//! loop in [`crate::agent_loop`].
//!
//! Everything that calls the model goes through [`run_agent`] (a manual run,
//! an event, a routine, a room reply) or [`agent_turn`] (a chat turn). Without
//! a provider both answer what the worker answers without its model: 503
//! `ai_unavailable`.

use std::sync::Arc;

use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ai::{Ai, AiError};
use weldsuite_kit::ApiError;
use weldsuite_ports::DynRealtimePublisher;

use crate::access::{AgentAccess, agent_viewer_for, can_access_agent};
use crate::agent_loop::{
    ChatMsg, TurnInput, actor_may_edit, build_system, load_history, run_turn, to_model_history,
    tools_for, trim_history, with_sandbox_tools,
};
use crate::agents::get_agent;
use crate::approvals::persist_assistant_message;
use crate::routines::complete_routine_run;
use crate::runs::{RunCompletion, complete_agent_run, create_agent_run, mark_run_running};
use crate::tools::{EventSink, ToolContext};

/// `metadata.kind` of an assistant message posted by a routine run
/// (`ROUTINE_RESULT_KIND`).
pub const ROUTINE_RESULT_KIND: &str = "routine_result";

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

/// What a run needs from the process besides its database.
#[derive(Clone, Default)]
pub struct RunEnv {
    /// The master database: credit wallet and ops ledger.
    pub master: Option<PgPool>,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// Whether the sandbox and web grants exist (see `AgentState::sandbox`).
    pub sandbox: bool,
    /// The install's sandbox, where a turn's sandbox and web tools run
    /// ([`turn_sandbox`]). `None` without one.
    pub sandboxes: Option<weldsuite_sandbox::Sandboxes>,
}

/// The sandbox of one turn ([`SandboxAccess::for_turn`]) for the session
/// `session_id`: the conversation (chat) or run id. `None` without a sandbox
/// on the install.
pub(crate) async fn turn_sandbox(
    env: &RunEnv,
    ai: &Ai,
    agent: &Value,
    ctx: &ToolContext,
    session_id: &str,
) -> Option<crate::tools::SandboxAccess> {
    let call = crate::agent_loop::agent_call(agent, ctx, session_id);
    crate::tools::SandboxAccess::for_turn(
        env.sandboxes.as_ref(),
        Some(ai),
        &call,
        agent["id"].as_str().unwrap_or_default(),
        session_id,
    )
    .await
}

impl std::fmt::Debug for RunEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunEnv")
            .field("sandbox", &self.sandbox)
            .finish_non_exhaustive()
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
    pub env: RunEnv,
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
        let mut out = json!({ "runId": self.run_id, "text": self.text, "success": self.success });
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
    pub env: RunEnv,
}

/// Why the loop did not answer.
#[derive(Debug)]
pub enum RunError {
    /// No model (no provider configured).
    Unavailable,
    /// The model call failed or was refused (the 402 gate included).
    Ai(AiError),
    /// The agent or conversation is gone.
    NotFound(String),
    /// The caller lost access to the agent.
    Forbidden(String),
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
            Self::Forbidden(message) => ApiError::forbidden().with_message(message).into_response(),
            Self::Failed(message) => {
                tracing::error!(%message, "[agent-api] {fallback}");
                ApiError::internal().with_message(message).into_response()
            }
        }
    }
}

impl From<sqlx::Error> for RunError {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

/// 503 `ai_unavailable`, "AI is currently unavailable": what agent-api's
/// stubbed AI routes answer.
pub fn unavailable() -> Response {
    (
        http::StatusCode::SERVICE_UNAVAILABLE,
        axum::Json(json!({ "error": { "code": "ai_unavailable", "message": "AI is currently unavailable" } })),
    )
        .into_response()
}

fn str_list(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The tool context of a run for `agent`.
pub fn tool_context(
    agent: &Value,
    env: &RunEnv,
    ai: Option<&Ai>,
    db: &PgPool,
    workspace_id: &str,
    actor_user_id: &str,
    actor_permissions: Option<Vec<String>>,
    events: Option<EventSink>,
) -> ToolContext {
    ToolContext {
        db: db.clone(),
        agent_id: agent["id"].as_str().unwrap_or_default().to_owned(),
        actor_user_id: actor_user_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
        agent_permissions: str_list(agent, "permissions"),
        enabled_tools: str_list(agent, "enabledTools"),
        user_timezone: None,
        actor_can_edit: actor_may_edit(agent, actor_user_id, actor_permissions.as_deref()),
        actor_permissions,
        row_scope: None,
        events,
        sandbox: env.sandbox,
        channel_id: None,
        conversation_id: None,
        agent_hop: 0,
        max_agent_hops: 2,
        master: env.master.clone(),
        realtime: env.realtime.clone(),
        ai: ai.cloned(),
    }
}

pub(crate) fn has_sandbox_tools(tools: &[&crate::tools::ToolSpec]) -> bool {
    tools.iter().any(|t| {
        t.name.starts_with("computer_")
            || t.name.starts_with("browser_")
            || t.name.starts_with("web_")
    })
}

/// A long run's final reply goes to the routine owner's main chat
/// (`deliverRoutineResult`); returns the chat id.
async fn deliver_routine_result(
    db: &PgPool,
    routine: &Value,
    user_id: &str,
    agent: &Value,
    run_id: &str,
    ok: bool,
    text: &str,
    error: Option<&str>,
) {
    if user_id.is_empty() || user_id == "system" {
        return;
    }
    let result = async {
        let conversation = crate::conversations::get_or_create_main(
            db,
            user_id,
            agent["id"].as_str().unwrap_or_default(),
            agent["name"].as_str().unwrap_or("Agent"),
        )
        .await?;
        let name = routine["name"].as_str().unwrap_or_default();
        let content = if ok {
            text.to_owned()
        } else {
            format!(
                "The routine \"{name}\" did not finish: {}",
                error.unwrap_or("unknown error")
            )
        };
        let metadata = json!({
            "kind": ROUTINE_RESULT_KIND, "routineId": routine["id"], "routineName": name,
            "runId": run_id, "success": ok,
        });
        persist_assistant_message(
            db,
            conversation["id"].as_str().unwrap_or_default(),
            &content,
            None,
            Some(&metadata),
        )
        .await
    }
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "[weldagent/routine] delivering the result failed");
    }
}

/// `executeAgentRun(params)`: run an agent once (manual, event, routine, room
/// reply), persist the run and, for a routine, close its run row and post the
/// result in its owner's chat.
///
/// # Errors
///
/// [`RunError::Unavailable`] without a provider; [`RunError::NotFound`] when
/// the agent is gone. A failed run is an `Ok` outcome with `success: false`,
/// as in TypeScript.
#[allow(clippy::too_many_lines)] // the steps of one run, in TypeScript's order
pub async fn run_agent(ai: Option<&Ai>, params: RunParams) -> Result<RunOutcome, RunError> {
    let Some(ai) = ai.filter(|ai| ai.enabled()) else {
        return Err(RunError::Unavailable);
    };
    let db = &params.db;
    let Some(agent) = get_agent(db, &params.agent_id).await? else {
        return Err(RunError::NotFound("Agent".to_owned()));
    };
    // Unattended runs only fire for live agents; manual runs work in any state.
    if params.trigger_type == TriggerType::Event && agent["status"] != "active" {
        return Ok(RunOutcome {
            run_id: params.run_id.clone().unwrap_or_default(),
            text: String::new(),
            success: false,
            error: Some(format!(
                "Agent is {}",
                agent["status"].as_str().unwrap_or("unavailable")
            )),
        });
    }
    let run_id = match &params.run_id {
        Some(id) => id.clone(),
        None => {
            create_agent_run(
                db,
                &params.agent_id,
                Some("queued"),
                params.trigger_type.as_str(),
                params.trigger_data.as_ref(),
            )
            .await?
        }
    };
    mark_run_running(db, &run_id).await?;

    let ctx = tool_context(
        &agent,
        &params.env,
        Some(ai),
        db,
        &params.workspace_id,
        &params.actor_user_id,
        params.actor_permissions.clone(),
        params.events.clone(),
    );
    // A run has its own sandbox session, released when the run ends.
    let sandbox = turn_sandbox(&params.env, ai, &agent, &ctx, &run_id).await;
    let tools = with_sandbox_tools(&agent, &ctx, sandbox.as_ref(), tools_for(&agent, &ctx, 2));
    let system = build_system(
        db,
        &agent,
        has_sandbox_tools(&tools),
        params.extra_system.as_deref(),
    )
    .await;
    let session = sandbox
        .as_ref()
        .map(|access| (access.sandboxes.clone(), access.session.clone()));
    let turn = run_turn(TurnInput {
        ai,
        agent: &agent,
        ctx: &ctx,
        system,
        history: vec![ChatMsg::user(params.user_message.clone())],
        tools,
        skip_approvals: params.skip_approvals,
        reference: run_id.clone(),
        sandbox,
    })
    .await;
    if let Some((sandboxes, key)) = session
        && let Err(error) = sandboxes.release(&key).await
    {
        tracing::warn!(%error, run_id, "[weldagent] releasing the run's sandbox failed");
    }

    let routine = match (
        &params.routine_run_id,
        params
            .trigger_data
            .as_ref()
            .and_then(|d| d["routineId"].as_str()),
    ) {
        (Some(_), Some(routine_id)) => sqlx::query_scalar::<_, Value>(
            "select to_jsonb(r) from weldagent_routines r where r.id = $1",
        )
        .bind(routine_id)
        .fetch_optional(db)
        .await?
        .map(weldsuite_db::js_row),
        _ => None,
    };
    let owner = routine
        .as_ref()
        .and_then(|r| r["createdBy"].as_str())
        .unwrap_or(&params.actor_user_id)
        .to_owned();

    let outcome = match turn {
        Ok(done) => {
            let actions: Vec<Value> = done
                .invocations
                .iter()
                .filter(|t| t["state"] == "result" || t["state"] == "error")
                .map(|t| {
                    json!({ "tool": t["toolName"], "description": if t["state"] == "error" { "failed" } else { "ok" },
                            "success": t["state"] == "result" })
                })
                .collect();
            let summary: String = done.text.chars().take(2000).collect();
            complete_agent_run(
                db,
                &run_id,
                &params.agent_id,
                RunCompletion {
                    success: true,
                    result: Some(json!({ "summary": summary, "actionsPerformed": actions, "toolInvocations": done.invocations })),
                    error: None,
                    total_iterations: done.steps,
                    total_tokens_used: done.tokens,
                    tool_call_count: i64::try_from(actions.len()).unwrap_or_default(),
                },
            )
            .await?;
            RunOutcome {
                run_id: run_id.clone(),
                text: done.text,
                success: true,
                error: None,
            }
        }
        Err(error) => {
            let message = error.to_string();
            complete_agent_run(
                db,
                &run_id,
                &params.agent_id,
                RunCompletion {
                    success: false,
                    error: Some(message.clone()),
                    ..RunCompletion::default()
                },
            )
            .await?;
            RunOutcome {
                run_id: run_id.clone(),
                text: String::new(),
                success: false,
                error: Some(message),
            }
        }
    };

    if let (Some(routine_run_id), Some(routine)) = (&params.routine_run_id, &routine) {
        let status = if outcome.success {
            "completed"
        } else {
            "failed"
        };
        let summary: String = outcome.text.chars().take(2000).collect();
        complete_routine_run(
            db,
            routine_run_id,
            status,
            outcome.success.then_some(summary.as_str()),
            outcome.error.as_deref(),
            Some(&run_id),
        )
        .await?;
        deliver_routine_result(
            db,
            routine,
            &owner,
            &agent,
            &run_id,
            outcome.success,
            &outcome.text,
            outcome.error.as_deref(),
        )
        .await;
    }
    Ok(outcome)
}

/// `Sorry — I could not finish that reply (…)`: what a failed turn leaves in
/// the chat so async clients stop polling (`persistFailedAssistantTurn`).
fn failed_reply(error: &str) -> String {
    if error.trim().is_empty() {
        "Sorry — I could not finish that reply. Try again in a moment.".to_owned()
    } else {
        format!("Sorry — I could not finish that reply ({error}). Try again in a moment.")
    }
}

struct Accepted {
    conversation_id: String,
    agent: Value,
    user_message: Value,
    history: Vec<ChatMsg>,
    user_turns: usize,
}

/// Generate and persist the assistant's reply of an accepted turn
/// (`finishAcceptedTurn`).
async fn finish_turn(ai: &Ai, params: &TurnParams, accepted: &Accepted) -> Value {
    let db = &params.db;
    let ctx = {
        let mut ctx = tool_context(
            &accepted.agent,
            &params.env,
            Some(ai),
            db,
            &params.workspace_id,
            &params.user_id,
            Some(params.actor_permissions.clone()),
            params.events.clone(),
        );
        ctx.conversation_id = Some(accepted.conversation_id.clone());
        ctx.user_timezone.clone_from(&params.timezone);
        ctx
    };
    // A conversation keeps one sandbox session; the idle sweep ends it.
    let sandbox = turn_sandbox(
        &params.env,
        ai,
        &accepted.agent,
        &ctx,
        &accepted.conversation_id,
    )
    .await;
    let tools = with_sandbox_tools(
        &accepted.agent,
        &ctx,
        sandbox.as_ref(),
        tools_for(&accepted.agent, &ctx, accepted.user_turns),
    );
    let extra = params.timezone.as_deref().map(|tz| {
        format!("The user's timezone is {tz}. Read and schedule times (routines included) in it unless they say otherwise.")
    });
    let system = build_system(
        db,
        &accepted.agent,
        has_sandbox_tools(&tools),
        extra.as_deref(),
    )
    .await;
    let turn = run_turn(TurnInput {
        ai,
        agent: &accepted.agent,
        ctx: &ctx,
        system,
        history: accepted.history.clone(),
        tools,
        skip_approvals: false,
        reference: accepted.conversation_id.clone(),
        sandbox,
    })
    .await;
    let (text, invocations, credits, success, error) = match turn {
        Ok(done) => {
            let invocations =
                (!done.invocations.is_empty()).then_some(Value::Array(done.invocations));
            (done.text, invocations, done.credits, true, None)
        }
        Err(error) => (
            failed_reply(&error.to_string()),
            None,
            0,
            false,
            Some(error.to_string()),
        ),
    };
    let saved = persist_assistant_message(
        db,
        &accepted.conversation_id,
        &text,
        invocations.as_ref(),
        None,
    )
    .await;
    let assistant = saved.unwrap_or_else(|error| {
        tracing::error!(%error, "[weldagent/complete-turn] could not save the reply");
        Value::Null
    });
    let mut out = json!({
        "status": "completed", "pending": false, "userMessage": accepted.user_message,
        "assistantMessage": assistant, "creditsUsed": credits, "success": success,
    });
    if let (Some(error), Some(map)) = (error, out.as_object_mut()) {
        map.insert("error".into(), Value::String(error));
    }
    out
}

/// `completeConversationTurn(params)`: one chat turn. The user's message is
/// saved first; the reply is generated here (`wait`) or in the background
/// (the answer is then `status: accepted`).
///
/// A conversation without an agent is the assistant (`/api/ai`), which has its
/// own runtime; it answers 503 here until that is wired in.
///
/// # Errors
///
/// [`RunError`]: no provider, a missing conversation or agent, an agent the
/// caller lost access to, the 402 gate.
pub async fn agent_turn(ai: Option<&Ai>, params: TurnParams) -> Result<Value, RunError> {
    let Some(ai) = ai.filter(|ai| ai.enabled()).cloned() else {
        return Err(RunError::Unavailable);
    };
    let db = &params.db;
    let conversation: Value = sqlx::query_scalar(
        "select to_jsonb(c) from weldagent_conversations c
         where c.id = $1 and c.user_id = $2 and c.deleted_at is null",
    )
    .bind(&params.conversation_id)
    .bind(&params.user_id)
    .fetch_optional(db)
    .await?
    .map(weldsuite_db::js_row)
    .ok_or_else(|| {
        RunError::NotFound(format!("Conversation with ID '{}'", params.conversation_id))
    })?;
    let bound = params
        .agent_id
        .clone()
        .or_else(|| conversation["agentId"].as_str().map(str::to_owned));
    let Some(agent_id) = bound else {
        return Err(RunError::Unavailable);
    };
    let Some(agent) = get_agent(db, &agent_id).await? else {
        return Err(RunError::Forbidden(
            "You no longer have access to this agent".to_owned(),
        ));
    };
    // An agent's chat stays usable only while its owner keeps you on it.
    let subject = weldsuite_permissions::Grants {
        permissions: params.actor_permissions.clone(),
        denies: Vec::new(),
    };
    let viewer = agent_viewer_for(&params.user_id, Some(&subject));
    let allowed = can_access_agent(
        db,
        &AgentAccess {
            id: &agent_id,
            owner_id: agent["ownerId"].as_str(),
            visibility: agent["visibility"].as_str().unwrap_or("workspace"),
        },
        &viewer,
    )
    .await?;
    if !allowed {
        return Err(RunError::Forbidden(
            "You no longer have access to this agent".to_owned(),
        ));
    }
    // The 402 gate, before anything is saved.
    let gate_ctx = tool_context(
        &agent,
        &params.env,
        Some(&ai),
        db,
        &params.workspace_id,
        &params.user_id,
        None,
        None,
    );
    crate::agent_loop::assert_credits(
        &ai,
        &agent,
        &gate_ctx,
        conversation["id"].as_str().unwrap_or_default(),
    )
    .await
    .map_err(RunError::Ai)?;
    if params.agent_id.is_some() && conversation["agentId"].is_null() {
        sqlx::query("update weldagent_conversations set agent_id = $2, updated_at = $3::timestamptz where id = $1")
            .bind(&params.conversation_id)
            .bind(&agent_id)
            .bind(crate::now())
            .execute(db)
            .await?;
    }
    let (rows, _offset) = load_history(db, &params.conversation_id, None).await?;
    let user_turns = rows.iter().filter(|r| r["role"] == "user").count() + 1;
    let mut history = trim_history(to_model_history(&rows));
    history.push(ChatMsg::user(params.content.clone()));

    let message_id = weldsuite_kit::generate_id("msg");
    sqlx::query("insert into weldagent_messages (id, conversation_id, role, content) values ($1, $2, 'user', $3)")
        .bind(&message_id)
        .bind(&params.conversation_id)
        .bind(&params.content)
        .execute(db)
        .await?;
    sqlx::query(
        "update weldagent_conversations
         set last_message_at = $2::timestamptz, message_count = message_count + 1, updated_at = $2::timestamptz
         where id = $1",
    )
    .bind(&params.conversation_id)
    .bind(crate::now())
    .execute(db)
    .await?;
    let user_message: Value =
        sqlx::query_scalar("select to_jsonb(m) from weldagent_messages m where m.id = $1")
            .bind(&message_id)
            .fetch_one(db)
            .await
            .map(weldsuite_db::js_row)?;
    let accepted = Accepted {
        conversation_id: params.conversation_id.clone(),
        agent,
        user_message,
        history,
        user_turns,
    };
    if params.wait {
        return Ok(finish_turn(&ai, &params, &accepted).await);
    }
    let user_message = accepted.user_message.clone();
    // The reply is generated in the background; the client polls the messages.
    tokio::spawn(async move {
        let _ = finish_turn(&ai, &params, &accepted).await;
    });
    Ok(
        json!({ "status": "accepted", "pending": true, "userMessage": user_message, "assistantMessage": null }),
    )
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
            env: RunEnv::default(),
        };
        assert!(matches!(
            run_agent(None, params).await,
            Err(RunError::Unavailable)
        ));
    }

    #[test]
    fn the_unavailable_answer_is_the_workers() {
        assert_eq!(
            unavailable().status(),
            http::StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn a_failed_turn_leaves_a_reply() {
        assert!(failed_reply("boom").contains("(boom)"));
        assert!(!failed_reply(" ").contains('('));
    }
}
