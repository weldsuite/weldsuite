//! The agent loop (`packages/domains/agent/src/executor.ts`, rebuilt for the
//! Kubernetes editions over [`weldsuite_ai`], ADR AI-012 phase 5).
//!
//! Global runs an agent on a Claude Managed Agents session. Here every turn is
//! a loop of `ai.chat` calls: the model answers, asks for tools, the tools run
//! through [`crate::tools::execute_tool`] (high-risk ones park an approval
//! first), their results go back to the model, until it answers without a tool
//! call or the budget (`maxIterations`, `maxTotalTokens`) is spent. Each model
//! call is charged by the AI crate, which also applies the policy (the
//! `agents` feature's provider and model), the fallback and the 402 gate.
//!
//! The conversation is rebuilt from `weldagent_messages` on every turn
//! ([`load_history`]), newest messages first within a character budget, so no
//! server-side session exists and a chat moves between editions untouched.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ai::{
    Ai, AiCall, AiError, ChatRequest, Feature, Message, Part, Role, Task, Tier, ToolCall,
};

use crate::access::{agent_viewer_for, can_edit_agent};
use crate::agents::POLICY_DEFAULT_MODEL;
use crate::approvals::{
    allows_auto_review, approval_label, approval_recipients, create_approval, find_prior_approval,
    held_for_approval_message, tool_risk_level,
};
use crate::tools::{ToolContext, ToolError, ToolSpec, execute_tool, tool_defs, tools_for_agent_turn};

/// `PRESENTATION_RULES`: how every workspace agent talks about records.
pub const PRESENTATION_RULES: &str = "Never show internal ids (for example prj_…, task_…, per_…, apr_…, agt_…), tool names or raw field keys to the user. \
Refer to records by their name, title or number.";

const SETUP_INTERVIEW_INSTRUCTIONS: &str = "SETUP MODE — you do not have a job or a real name yet (you may appear as \"Untitled\").\n\
The user was just asked \"What should this agent do?\" and their first message is the answer. \
Interview them until you know your purpose AND your routines, then save your setup.\n\n\
HOW TO ASK:\n\
- Ask every question with the ask_user tool: one focused question, 2-4 concrete options that fit what they told you. \
They can always type their own answer, so do not add an \"other\" option.\n\
- Before calling ask_user, write at most one short sentence (or nothing). Do not repeat the question or the options in text.\n\
- After ask_user, end your turn. Their answer arrives as the next message.\n\
- Usually 2-4 questions are enough: what to focus on, when to act (new records, a schedule, only when asked in chat), \
and what to do each time. Skip anything their answers already cover.\n\n\
HARD RULES:\n\
- NEVER call save_agent_setup until the user has answered at least one question about routines (when you act).\n\
- NEVER say you are \"active\", \"ready\", or \"now helping\" until save_agent_setup has succeeded.\n\
- Set activate=true only if the user explicitly asks you to go live / activate; otherwise set activate=false and you keep your current status (a new agent stays a draft).\n\
- Do not invent workspace data or claim you already run automations.\n\n\
When purpose and routines are clear, call save_agent_setup with a short display name, lasting systemPrompt, description, \
and the workspace permissions the job needs (e.g. tasks:read for a task digest, tickets:read and tickets:update for triage). \
If it reports permissions it could not grant, say so. \
After a successful save, confirm in two or three sentences who you are and what you will do.";

/// `agentNeedsSetup(systemPrompt)`.
pub fn agent_needs_setup(system_prompt: &str) -> bool {
    system_prompt.trim().is_empty()
}

/// `buildSystemPrompt(agent)`. The sentence about the sandbox, web and browser
/// tools is there only when the agent has such a tool this turn
/// (`has_sandbox_tools`): the Kubernetes editions have them once the sandbox
/// crate registers them.
pub fn build_system_prompt(name: &str, system_prompt: &str, has_sandbox_tools: bool) -> String {
    if agent_needs_setup(system_prompt) {
        return format!(
            "You are \"{name}\", a workspace AI agent in WeldSuite that is being configured for the first time.\n\n{PRESENTATION_RULES}\n\n{SETUP_INTERVIEW_INSTRUCTIONS}"
        );
    }
    let tools_hint = if has_sandbox_tools {
        "Prefer WeldSuite tools (people, tickets, tasks, chat) when they fit. When you have them, use your sandbox (bash, files) for scripts, data work and code, \
         web search / fetch to look things up, and browser_* only for interactive websites without an API. "
    } else {
        "Prefer WeldSuite tools (people, tickets, tasks, chat) when they fit. "
    };
    let own = system_prompt.trim();
    format!(
        "You are \"{name}\", a workspace AI agent in WeldSuite. \
         You act on workspace data only through the WeldSuite tools you have been given. Never invent IDs or claim you mutated data without a successful tool result. \
         {PRESENTATION_RULES} {tools_hint}\
         When you need a decision or a missing detail from the user, ask it with ask_user (one question, concrete options) and end your turn. \
         Be concise and practical.\n\n{}",
        if own.is_empty() { "Help the user with their workspace tasks." } else { own }
    )
}

/// The skills and memory blocks of the system prompt (`skillsPromptBlock`,
/// `memoryPromptBlock`).
async fn prompt_blocks(db: &PgPool, agent_id: &str) -> String {
    let mut out = String::new();
    let skills: Vec<(String, String)> = sqlx::query_as(
        "select s.name, s.instructions from weldagent_agent_skills a join weldagent_skills s on s.id = a.skill_id
         where a.agent_id = $1 and a.enabled = true and s.status = 'active' and s.deleted_at is null
         order by s.updated_at desc",
    )
    .bind(agent_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    if !skills.is_empty() {
        out.push_str("\n\nEnabled skills (follow when relevant):\n");
        let lines: Vec<String> = skills
            .iter()
            .map(|(name, instructions)| format!("- {name}: {}", instructions.chars().take(1500).collect::<String>()))
            .collect();
        out.push_str(&lines.join("\n"));
    }
    let memories: Vec<(String, String)> = sqlx::query_as(
        "select kind, content from weldagent_memories where agent_id = $1 and deleted_at is null
         order by created_at desc limit 40",
    )
    .bind(agent_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    if !memories.is_empty() {
        out.push_str("\n\nDurable memory for this agent:\n");
        let lines: Vec<String> = memories.iter().map(|(kind, content)| format!("- [{kind}] {content}")).collect();
        out.push_str(&lines.join("\n"));
    }
    out
}

/// `buildSessionSystem(input)`: the agent's prompt plus skills, memory and the
/// run's own context.
pub async fn build_system(
    db: &PgPool,
    agent: &Value,
    has_sandbox_tools: bool,
    extra_system: Option<&str>,
) -> String {
    let prompt = agent["systemPrompt"].as_str().unwrap_or_default();
    let mut system = build_system_prompt(agent["name"].as_str().unwrap_or("Agent"), prompt, has_sandbox_tools);
    if !agent_needs_setup(prompt) {
        system.push_str(&prompt_blocks(db, agent["id"].as_str().unwrap_or_default()).await);
    }
    match extra_system {
        Some(extra) if !extra.is_empty() => format!("{system}\n\n{extra}"),
        _ => system,
    }
}

/// How many messages a chat turn reads at most (`HISTORY_WINDOW`).
pub const HISTORY_WINDOW: i64 = 80;
/// Characters of history a turn carries (`SEED_HISTORY_MAX_CHARS`).
pub const HISTORY_MAX_CHARS: usize = 120_000;
const TOOL_SUMMARY_MAX_CHARS: usize = 1500;

/// One earlier message of the conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMsg {
    pub role: Role,
    pub content: String,
}

impl ChatMsg {
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: Role::User, content: content.into() }
    }
}

/// `summarizeToolInvocations(raw)`: what an assistant turn's tools did, as
/// text the next turn can read.
fn summarize_tool_invocations(raw: &Value) -> String {
    let Some(items) = raw.as_array() else { return String::new() };
    let mut lines: Vec<String> = Vec::new();
    for inv in items {
        let state = inv["state"].as_str().unwrap_or_default();
        if state != "result" && state != "error" {
            continue;
        }
        let mut result = serde_json::to_string(&inv["result"]).unwrap_or_else(|_| "[unserializable]".to_owned());
        if result.chars().count() > 400 {
            result = format!("{}…", result.chars().take(400).collect::<String>());
        }
        lines.push(format!("- {} → {result}", inv["toolName"].as_str().unwrap_or_default()));
    }
    if lines.is_empty() {
        return String::new();
    }
    let summary = format!("[Tools used in this turn]\n{}", lines.join("\n"));
    if summary.chars().count() > TOOL_SUMMARY_MAX_CHARS {
        format!("{}…", summary.chars().take(TOOL_SUMMARY_MAX_CHARS).collect::<String>())
    } else {
        summary
    }
}

/// `toModelHistory(rows)`: user and assistant rows as model messages, an
/// assistant row followed by a summary of its tools.
pub fn to_model_history(rows: &[Value]) -> Vec<ChatMsg> {
    rows.iter()
        .filter_map(|row| {
            let content = row["content"].as_str().unwrap_or_default();
            match row["role"].as_str() {
                Some("user") => Some(ChatMsg { role: Role::User, content: content.to_owned() }),
                Some("assistant") => {
                    let tools = summarize_tool_invocations(&row["toolInvocations"]);
                    let content = if tools.is_empty() { content.to_owned() } else { format!("{content}\n\n{tools}") };
                    Some(ChatMsg { role: Role::Assistant, content })
                }
                _ => None,
            }
        })
        .collect()
}

/// `seedHistory(prior)`: the newest messages that fit [`HISTORY_MAX_CHARS`],
/// oldest first; the oldest turns are dropped first.
pub fn trim_history(history: Vec<ChatMsg>) -> Vec<ChatMsg> {
    let mut used = 0usize;
    let mut kept: Vec<ChatMsg> = Vec::new();
    for msg in history.into_iter().rev() {
        used += msg.content.chars().count();
        if used > HISTORY_MAX_CHARS && !kept.is_empty() {
            break;
        }
        kept.push(msg);
    }
    kept.reverse();
    // A model turn must open with a user message.
    while kept.first().is_some_and(|m| m.role != Role::User) && kept.len() > 1 {
        kept.remove(0);
    }
    kept
}

/// `loadRecentHistory(db, conversationId, throughId)`: the latest
/// [`HISTORY_WINDOW`] user and assistant rows (up to and including
/// `through_id`), oldest first, and how many earlier rows there are.
///
/// # Errors
///
/// The tenant database fails.
pub async fn load_history(
    db: &PgPool,
    conversation_id: &str,
    through_id: Option<&str>,
) -> Result<(Vec<Value>, i64), sqlx::Error> {
    let filter = "m.conversation_id = $1 and m.deleted_at is null and m.role in ('user', 'assistant')
        and ($2::text is null or (m.created_at, m.id) <= (select a.created_at, a.id from weldagent_messages a where a.id = $2))";
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(m) from weldagent_messages m where {filter} order by m.created_at desc, m.id desc limit $3"
    )))
    .bind(conversation_id)
    .bind(through_id)
    .bind(HISTORY_WINDOW)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*)::bigint from weldagent_messages m where {filter}"
    )))
    .bind(conversation_id)
    .bind(through_id)
    .fetch_one(db)
    .await?;
    let kept = i64::try_from(rows.len()).unwrap_or_default();
    let mut rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
    rows.reverse();
    Ok((rows, (total - kept).max(0)))
}

/// Tool results above this are cut before they go to the model
/// (`MAX_TOOL_RESULT_CHARS`).
const MAX_TOOL_RESULT_CHARS: usize = 60_000;
/// `MAX_STORED_RESULT_CHARS`.
const MAX_STORED_RESULT_CHARS: usize = 2_000;

fn result_text(value: &Value) -> String {
    let text = serde_json::to_string(value).unwrap_or_default();
    if text.chars().count() > MAX_TOOL_RESULT_CHARS {
        format!("{}…[truncated]", text.chars().take(MAX_TOOL_RESULT_CHARS).collect::<String>())
    } else {
        text
    }
}

/// A result as it is stored on the message: cut to
/// [`MAX_STORED_RESULT_CHARS`] when it is long text.
fn stored_result(value: &Value) -> Value {
    let text = serde_json::to_string(value).unwrap_or_default();
    if text.chars().count() > MAX_STORED_RESULT_CHARS * 10 {
        json!({ "truncated": true, "preview": text.chars().take(MAX_STORED_RESULT_CHARS).collect::<String>() })
    } else {
        value.clone()
    }
}

/// What one turn is run with.
pub struct TurnInput<'a> {
    pub ai: &'a Ai,
    pub agent: &'a Value,
    pub ctx: &'a ToolContext,
    pub system: String,
    pub history: Vec<ChatMsg>,
    pub tools: Vec<&'static ToolSpec>,
    /// Routine with "ask for approval" off: act without parking approvals.
    pub skip_approvals: bool,
    /// The ledger's `reference_id` (run, conversation or channel id).
    pub reference: String,
}

/// How a turn ended (`AgentExecutorResult`).
#[derive(Debug, Clone, Default)]
pub struct TurnResult {
    pub text: String,
    pub invocations: Vec<Value>,
    pub steps: i64,
    pub tokens: i64,
    pub credits: i64,
    /// `meta.ai` of the last model call.
    pub meta: Option<Value>,
}

/// The `AiCall` of one model call of an agent: the `agents` feature, the
/// agent's own model unless it is the policy sentinel.
fn agent_call(agent: &Value, ctx: &ToolContext, reference: &str) -> AiCall {
    let model = agent["modelId"].as_str().filter(|m| !m.is_empty() && *m != POLICY_DEFAULT_MODEL);
    AiCall::new(&ctx.workspace_id, Feature::Agents, Task::Copilot, Tier::Quality)
        .user(&ctx.actor_user_id)
        .tenant(ctx.db.clone())
        .master(ctx.master.clone())
        .stored_model(model)
        .op("agent")
        .reference(reference)
}

/// The 402 gate (AI-007) for a turn of this agent.
///
/// # Errors
///
/// [`AiError::InsufficientCredits`] and the policy's refusals.
pub async fn assert_credits(ai: &Ai, agent: &Value, ctx: &ToolContext, reference: &str) -> Result<(), AiError> {
    ai.assert_credits(&agent_call(agent, ctx, reference)).await
}

/// `notifyApprovalPeople`: who has to act on a parked approval. The push
/// notification itself is the notifications crate's; the recipients are
/// recorded on the approval's `reason` for the page to show.
async fn note_recipients(ctx: &ToolContext, agent: &Value, approval_id: &str) {
    let recipients = approval_recipients(
        agent["ownerId"].as_str(),
        Some(ctx.actor_user_id.as_str()),
        ctx.channel_id.is_some(),
    );
    if !recipients.is_empty() {
        tracing::info!(approval_id, ?recipients, "[weldagent] approval waiting");
    }
}

/// `executePlatformTool`: run one call of the model, parking an approval first
/// when the tool is high-risk (unless `skip_approvals`, or the agent reviews
/// by itself and the tool was approved before). Returns what the model is
/// told, whether it failed, and the stored step.
async fn run_tool_call(input: &TurnInput<'_>, call: &ToolCall) -> (Value, bool, Value) {
    let mut step = json!({ "toolName": call.name, "state": "call", "args": call.arguments });
    let ctx = input.ctx;
    let agent_id = input.agent["id"].as_str().unwrap_or_default();
    let risk = tool_risk_level(&call.name, Some(&call.arguments));
    if risk == "high" && !input.skip_approvals {
        let auto_review = input.agent["autoReviewEnabled"] == json!(true);
        let auto_ok = auto_review
            && allows_auto_review(&call.name)
            && find_prior_approval(&ctx.db, agent_id, &call.name).await.unwrap_or(false);
        if !auto_ok {
            let args = if call.arguments.is_object() { call.arguments.clone() } else { json!({ "value": call.arguments }) };
            let parked = create_approval(
                &ctx.db,
                agent_id,
                ctx.conversation_id.as_deref().or(ctx.channel_id.as_deref()),
                &call.name,
                &args,
                Some(&ctx.actor_user_id),
            )
            .await;
            return match parked {
                Ok(approval) => {
                    let label = approval_label(&call.name, &args);
                    let id = approval["id"].as_str().unwrap_or_default().to_owned();
                    note_recipients(ctx, input.agent, &id).await;
                    step["state"] = json!("result");
                    step["result"] = json!({
                        "pendingApproval": true, "approvalId": id, "label": label,
                        "message": format!("Waiting for approval: {label}"),
                    });
                    (json!({ "pendingApproval": true, "message": held_for_approval_message(&label) }), false, step)
                }
                Err(error) => {
                    tracing::error!(%error, "[weldagent] could not park an approval");
                    step["state"] = json!("error");
                    step["result"] = json!({ "error": "Could not ask for approval" });
                    (json!({ "error": "Could not ask for approval" }), true, step)
                }
            };
        }
    }
    match execute_tool(ctx, &call.name, &call.arguments).await {
        Ok(result) => {
            step["state"] = json!("result");
            step["result"] = stored_result(&result);
            (result, false, step)
        }
        Err(error) => {
            let message = match &error {
                ToolError::UnknownTool(name) => format!("Unknown tool: {name}"),
                other => other.message(),
            };
            step["state"] = json!("error");
            step["result"] = json!({ "error": message });
            (json!({ "error": message }), true, step)
        }
    }
}

/// `toolsForAgentTurn` for an agent row: setup mode, grants narrowed to the
/// actor, the owner-only tools.
pub fn tools_for(agent: &Value, ctx: &ToolContext, user_message_count: usize) -> Vec<&'static ToolSpec> {
    let strings = |key: &str| -> Vec<String> {
        agent[key].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
    };
    tools_for_agent_turn(
        &strings("permissions"),
        &strings("enabledTools"),
        agent["systemPrompt"].as_str().unwrap_or_default(),
        user_message_count,
        ctx.actor_permissions.as_deref(),
        ctx.actor_can_edit != Some(false),
    )
}

/// `actorMayEdit(agent, input)`: whether the person driving the turn may
/// change the agent; unattended runs keep maintaining their own agent.
pub fn actor_may_edit(agent: &Value, actor_user_id: &str, actor_permissions: Option<&[String]>) -> Option<bool> {
    let perms = actor_permissions?;
    let subject = weldsuite_permissions::Grants { permissions: perms.to_vec(), denies: Vec::new() };
    let viewer = agent_viewer_for(actor_user_id, Some(&subject));
    Some(can_edit_agent(agent["ownerId"].as_str(), &viewer))
}

/// Run one turn to its end.
///
/// # Errors
///
/// [`AiError`]: the 402 gate, no provider, or a provider failure the AI crate
/// could not fall back from.
pub async fn run_turn(input: TurnInput<'_>) -> Result<TurnResult, AiError> {
    let max_iterations = input.agent["maxIterations"].as_i64().unwrap_or(10).max(1);
    let max_tokens_total = input.agent["maxTotalTokens"].as_i64().unwrap_or(20_000);
    let max_tokens = input.agent["maxTokens"].as_i64().and_then(|n| u32::try_from(n).ok());
    let temperature = input.agent["temperature"].as_str().and_then(|t| t.parse::<f32>().ok());
    let call = agent_call(input.agent, input.ctx, &input.reference);
    input.ai.assert_credits(&call).await?;

    let mut messages: Vec<Message> = input
        .history
        .iter()
        .map(|m| Message { role: m.role, content: vec![Part::Text(m.content.clone())] })
        .collect();
    let defs = tool_defs(&input.tools);
    let mut result = TurnResult::default();
    let mut last_text = String::new();

    for step in 0..max_iterations {
        let mut request = ChatRequest {
            system: Some(input.system.clone()),
            messages: messages.clone(),
            tools: defs.clone(),
            ..ChatRequest::default()
        };
        request.max_tokens = max_tokens;
        request.temperature = temperature;
        let reply = input.ai.chat(&call, request).await?;
        result.steps = step + 1;
        result.tokens += reply.usage.input_tokens + reply.usage.output_tokens;
        result.credits += reply.credits;
        result.meta = Some(reply.served.meta());
        if !reply.text.is_empty() {
            last_text.clone_from(&reply.text);
        }
        if reply.tool_calls.is_empty() {
            result.text = reply.text;
            return Ok(result);
        }
        let mut assistant = vec![Part::Text(reply.text.clone())];
        assistant.extend(reply.tool_calls.iter().cloned().map(Part::ToolCall));
        messages.push(Message { role: Role::Assistant, content: assistant });
        let mut answers: Vec<Part> = Vec::new();
        let mut asked = false;
        for tool_call in &reply.tool_calls {
            // A tool the turn was not offered (setup mode, narrowed grants)
            // never runs, whatever the model asks for.
            let offered = input.tools.iter().any(|t| t.name == tool_call.name);
            let (answer, is_error, stored) = if offered {
                run_tool_call(&input, tool_call).await
            } else {
                let message = format!("Unknown tool: {}", tool_call.name);
                (
                    json!({ "error": message }),
                    true,
                    json!({ "toolName": tool_call.name, "state": "error", "args": tool_call.arguments, "result": { "error": message } }),
                )
            };
            asked |= tool_call.name == "ask_user" && !is_error;
            result.invocations.push(stored);
            answers.push(Part::ToolResult {
                call_id: tool_call.id.clone(),
                content: result_text(&answer),
                is_error,
            });
        }
        messages.push(Message { role: Role::Tool, content: answers });
        // `ask_user` ends the turn: the answer arrives as the next message.
        if asked {
            result.text = reply.text;
            return Ok(result);
        }
        if result.tokens >= max_tokens_total {
            break;
        }
    }
    result.text = last_text;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setup_prompt_interviews_and_the_normal_one_acts() {
        let setup = build_system_prompt("Untitled", "  ", false);
        assert!(setup.contains("SETUP MODE"));
        let normal = build_system_prompt("Triage", "Reply to tickets.", false);
        assert!(normal.contains("Reply to tickets."));
        assert!(!normal.contains("sandbox"));
        assert!(build_system_prompt("Triage", "x", true).contains("sandbox"));
    }

    #[test]
    fn history_keeps_the_newest_and_starts_with_a_user_turn() {
        let long = "x".repeat(HISTORY_MAX_CHARS);
        let history = vec![
            ChatMsg::user(long.clone()),
            ChatMsg { role: Role::Assistant, content: "old answer".into() },
            ChatMsg::user("new question"),
        ];
        let kept = trim_history(history);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].content, "new question");
    }

    #[test]
    fn assistant_rows_carry_a_tool_summary() {
        let rows = vec![
            json!({ "role": "user", "content": "hi" }),
            json!({ "role": "assistant", "content": "done", "toolInvocations": [
                { "toolName": "list_people", "state": "result", "result": { "totalCount": 1 } },
                { "toolName": "x", "state": "call" } ] }),
            json!({ "role": "system", "content": "ignored" }),
        ];
        let history = to_model_history(&rows);
        assert_eq!(history.len(), 2);
        assert!(history[1].content.contains("[Tools used in this turn]"));
        assert!(history[1].content.contains("list_people"));
        assert!(!history[1].content.contains("- x"));
    }

    #[test]
    fn owners_may_edit_unattended_runs_always() {
        let agent = json!({ "ownerId": "u1" });
        assert_eq!(actor_may_edit(&agent, "u2", None), None);
        assert_eq!(actor_may_edit(&agent, "u1", Some(&[])), Some(true));
        assert_eq!(actor_may_edit(&agent, "u2", Some(&[])), Some(false));
    }

    #[test]
    fn long_results_are_cut_for_the_model() {
        let big = json!({ "text": "y".repeat(MAX_TOOL_RESULT_CHARS + 10) });
        assert!(result_text(&big).ends_with("[truncated]"));
    }
}
