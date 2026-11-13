//! Approvals: a high-risk tool call does not run during the agent's turn, it
//! parks a `weldagent_approvals` row. Approving it runs the stored call with
//! the agent's grants narrowed to the approver's, and posts the outcome back
//! where the request came from (`packages/domains/agent/src/parity.ts`
//! approvals, `approval-labels.ts`,
//! `apps/workers/agent-api/src/services/weldagent/approvals.ts`,
//! `routes/weldagent/parity.ts` `/approvals`).
//!
//! Part one ports the rows, the risk rules, the labels, the two routes and the
//! run of an approved call. The agent loop creates approvals through
//! [`create_approval`] and tells the model [`held_for_approval_message`].
//! Posting the outcome into a WeldChat room comes with the rooms dispatch
//! (`rooms`, part two); a room's approval is decided and run, and its message
//! buttons are updated, but no reply is posted there yet.

use axum::body::Bytes;
use axum::extract::{Path, Query};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Data, generate_id};

use crate::access::can_edit_agent;
use crate::agents::get_agent;
use crate::grants::granter_holds;
use crate::tools::{ToolContext, ToolError, execute_tool};
use crate::{Caller, failed, now, validate};

const CONTEXT: &str = "weldagent/approvals";

/// `metadata.kind` of an assistant message that reports an approval's outcome.
pub const APPROVAL_OUTCOME_KIND: &str = "approval_outcome";

/// Tools that ask first (`HIGH_RISK_TOOLS`).
const HIGH_RISK_TOOLS: [&str; 10] = [
    "computer_exec",
    "computer_write_file",
    "computer_run_code",
    "create_person",
    "create_ticket",
    "create_task",
    "create_spreadsheet",
    "write_spreadsheet_range",
    "message_agent",
    "create_agent_group_chat",
];

/// `browser_act` actions that can submit forms or navigate on the user's
/// behalf.
const MUTATING_BROWSER_ACTIONS: [&str; 4] = ["goto", "click", "type", "press"];

/// Tools a past approval must never auto-approve: each call is arbitrary code
/// or browser input, so approving one command says nothing about the next.
const NEVER_AUTO_REVIEW: [&str; 4] = [
    "computer_exec",
    "computer_write_file",
    "computer_run_code",
    "browser_act",
];

/// `toolRiskLevel(toolName, args)`.
pub fn tool_risk_level(tool_name: &str, args: Option<&Value>) -> &'static str {
    if tool_name == "browser_act" {
        let action = args.and_then(|a| a.get("action")).and_then(Value::as_str);
        return if action.is_some_and(|a| MUTATING_BROWSER_ACTIONS.contains(&a)) {
            "high"
        } else {
            "low"
        };
    }
    if HIGH_RISK_TOOLS.contains(&tool_name) {
        "high"
    } else {
        "low"
    }
}

/// `allowsAutoReview(toolName)`: whether a prior approval of the same tool may
/// auto-approve this call.
pub fn allows_auto_review(tool_name: &str) -> bool {
    !NEVER_AUTO_REVIEW.contains(&tool_name)
}

// ── Labels (approval-labels.ts) ─────────────────────────────────────────────

struct ToolAction {
    /// The action as a heading ("Create task").
    pending: &'static str,
    /// After "I did not" / "I could not" ("create the task").
    infinitive: &'static str,
    /// After "Approved — " ("created the task").
    past: &'static str,
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

fn action_of(tool_name: &str) -> ToolAction {
    let (pending, infinitive, past) = match tool_name {
        "create_task" => ("Create task", "create the task", "created the task"),
        "create_person" => ("Create person", "create the person", "created the person"),
        "create_ticket" => ("Create ticket", "create the ticket", "created the ticket"),
        "create_spreadsheet" => (
            "Create spreadsheet",
            "create the spreadsheet",
            "created the spreadsheet",
        ),
        "write_spreadsheet_range" => (
            "Update a spreadsheet",
            "update the spreadsheet",
            "updated the spreadsheet",
        ),
        "message_agent" => (
            "Message another agent",
            "message the agent",
            "messaged the agent",
        ),
        "create_agent_group_chat" => (
            "Create group chat",
            "create the group chat",
            "created the group chat",
        ),
        "computer_exec" => (
            "Run a command in the sandbox",
            "run the command",
            "ran the command",
        ),
        "computer_write_file" => (
            "Write a file in the sandbox",
            "write the file",
            "wrote the file",
        ),
        "computer_run_code" => ("Run code in the sandbox", "run the code", "ran the code"),
        "browser_act" => ("Use the browser", "use the browser", "used the browser"),
        _ => ("Run an action", "run that action", "ran that action"),
    };
    ToolAction {
        pending,
        infinitive,
        past,
    }
}

/// The record's name from the call's arguments (`ToolAction.name`).
fn name_from_args(tool_name: &str, args: &Value) -> Option<String> {
    match tool_name {
        "create_task" => text(args.get("title")),
        "create_person" => {
            let full: Vec<String> = [text(args.get("firstName")), text(args.get("lastName"))]
                .into_iter()
                .flatten()
                .collect();
            if full.is_empty() {
                text(args.get("email"))
            } else {
                Some(full.join(" "))
            }
        }
        "create_ticket" => text(args.get("subject")),
        "create_spreadsheet" | "create_agent_group_chat" => text(args.get("name")),
        _ => None,
    }
}

const NAME_MAX_CHARS: usize = 80;

/// The record's name: from what the tool returned when it ran, else from its
/// arguments (`recordName`).
fn record_name(tool_name: &str, args: &Value, result: Option<&Value>) -> Option<String> {
    let returned = result.cloned().unwrap_or(Value::Null);
    let from_result = text(returned.get("title"))
        .or_else(|| text(returned.get("fullName")))
        .or_else(|| text(returned.get("subject")))
        .or_else(|| text(returned.get("name")));
    let name = from_result.or_else(|| name_from_args(tool_name, args))?;
    if name.chars().count() > NAME_MAX_CHARS {
        let cut: String = name.chars().take(NAME_MAX_CHARS - 1).collect();
        Some(format!("{cut}…"))
    } else {
        Some(name)
    }
}

fn quoted(name: Option<&str>) -> String {
    name.map_or_else(String::new, |n| format!(" \"{n}\""))
}

/// `approvalLabel(toolName, args)`: the action waiting for approval, as
/// `Create task "QA agent chat task"`.
pub fn approval_label(tool_name: &str, args: &Value) -> String {
    let action = action_of(tool_name);
    format!(
        "{}{}",
        action.pending,
        quoted(record_name(tool_name, args, None).as_deref())
    )
}

/// `approvedOutcome`: `Approved — created the task "QA agent chat task".`
pub fn approved_outcome(tool_name: &str, args: &Value, result: &Value) -> String {
    let action = action_of(tool_name);
    format!(
        "Approved — {}{}.",
        action.past,
        quoted(record_name(tool_name, args, Some(result)).as_deref())
    )
}

/// `rejectedOutcome`: the note after an action was rejected.
pub fn rejected_outcome(tool_name: &str, args: &Value) -> String {
    let action = action_of(tool_name);
    format!(
        "Rejected — I did not {}{}.",
        action.infinitive,
        quoted(record_name(tool_name, args, None).as_deref())
    )
}

/// `failedOutcome`: the note after an approved action failed to run.
pub fn failed_outcome(tool_name: &str, args: &Value, error: &str) -> String {
    let action = action_of(tool_name);
    format!(
        "Approved, but I could not {}{}: {error}",
        action.infinitive,
        quoted(record_name(tool_name, args, None).as_deref())
    )
}

/// `heldForApprovalMessage(label)`: what the model is told about an action
/// that is held: no id to repeat, and what to say.
pub fn held_for_approval_message(label: &str) -> String {
    format!(
        "Held for approval: {label}. It has NOT run yet; it runs once the user approves it. \
         Tell the user it is waiting for their approval (the Approve button on the agent page, or in the channel). \
         Do not mention ids or tool names, do not retry it, and do not say it is done."
    )
}

/// `approvalRecipients`: who hears about a held action: the agent's owner
/// (unless they asked themselves and see it in their chat), and whoever asked
/// in a room, where there is no chat of theirs to show it.
pub fn approval_recipients(
    owner_id: Option<&str>,
    actor_user_id: Option<&str>,
    in_channel: bool,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(owner) = owner_id.filter(|o| !o.is_empty() && Some(*o) != actor_user_id) {
        out.push(owner.to_owned());
    }
    if in_channel
        && let Some(actor) = actor_user_id.filter(|a| !a.is_empty() && *a != "system")
        && !out.iter().any(|o| o == actor)
    {
        out.push(actor.to_owned());
    }
    out
}

// ── Rows ────────────────────────────────────────────────────────────────────

/// `serializeApproval(row)`.
fn serialize(row: Value) -> Value {
    let row = js_row(row);
    let pick = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": pick("id"),
        "agentId": pick("agentId"),
        "conversationId": pick("conversationId"),
        "toolName": pick("toolName"),
        "args": if row["args"].is_null() { json!({}) } else { pick("args") },
        "riskLevel": pick("riskLevel"),
        "status": pick("status"),
        "reason": pick("reason"),
        "decidedBy": pick("decidedBy"),
        "decidedAt": pick("decidedAt"),
        "createdBy": pick("createdBy"),
        "createdAt": pick("createdAt"),
        "updatedAt": pick("updatedAt"),
    })
}

/// `createApproval(db, input)`: park a call. `risk_level` defaults to
/// [`tool_risk_level`] of the tool.
///
/// # Errors
///
/// The tenant database fails.
pub async fn create_approval(
    db: &PgPool,
    agent_id: &str,
    conversation_id: Option<&str>,
    tool_name: &str,
    args: &Value,
    created_by: Option<&str>,
) -> Result<Value, sqlx::Error> {
    let id = generate_id("apr");
    sqlx::query(
        "insert into weldagent_approvals (id, agent_id, conversation_id, tool_name, args, risk_level, status, created_by)
         values ($1, $2, $3, $4, $5::jsonb, $6, 'pending', $7)",
    )
    .bind(&id)
    .bind(agent_id)
    .bind(conversation_id)
    .bind(tool_name)
    .bind(args)
    .bind(tool_risk_level(tool_name, None))
    .bind(created_by)
    .execute(db)
    .await?;
    Ok(get_approval(db, &id).await?.unwrap_or(Value::Null))
}

/// `listApprovals(db, { agentId, status })`: newest first, at most 100.
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_approvals(
    db: &PgPool,
    agent_id: Option<&str>,
    status: Option<&str>,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from weldagent_approvals a
         where ($1::text is null or a.agent_id = $1) and ($2::text is null or a.status = $2)
         order by a.created_at desc limit 100",
    )
    .bind(agent_id)
    .bind(status)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(serialize).collect())
}

/// `getApproval(db, id)`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn get_approval(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(a) from weldagent_approvals a where a.id = $1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(serialize))
}

/// `decideApproval(db, id, { decision, decidedBy, reason })`: `None` when it
/// is not pending (or another click decided it first).
///
/// # Errors
///
/// The tenant database fails.
pub async fn decide_approval(
    db: &PgPool,
    id: &str,
    decision: &str,
    decided_by: &str,
    reason: Option<&str>,
) -> Result<Option<Value>, sqlx::Error> {
    // Conditional on still-pending so a double click can't run the action twice.
    let claimed = sqlx::query(
        "update weldagent_approvals
         set status = $2, decided_by = $3, decided_at = $5::timestamptz, reason = $4, updated_at = $5::timestamptz
         where id = $1 and status = 'pending'",
    )
    .bind(id)
    .bind(decision)
    .bind(decided_by)
    .bind(reason)
    .bind(now())
    .execute(db)
    .await?;
    if claimed.rows_affected() == 0 {
        return Ok(None);
    }
    get_approval(db, id).await
}

/// `findPriorApproval(db, agentId, toolName)`: whether the tool was approved
/// before (`autoReviewEnabled` lets that auto-approve a repeat).
///
/// # Errors
///
/// The tenant database fails.
pub async fn find_prior_approval(
    db: &PgPool,
    agent_id: &str,
    tool_name: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists (select 1 from weldagent_approvals where agent_id = $1 and tool_name = $2 and status = 'approved')",
    )
    .bind(agent_id)
    .bind(tool_name)
    .fetch_one(db)
    .await
}

// ── Running a decided approval (services/weldagent/approvals.ts) ───────────

/// `ApprovalExecution`.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalExecution {
    pub ran: bool,
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<String>,
}

impl ApprovalExecution {
    fn to_json(&self) -> Value {
        let mut out = json!({ "ran": self.ran, "ok": self.ok });
        if let Some(map) = out.as_object_mut() {
            if let Some(result) = &self.result {
                map.insert("result".into(), result.clone());
            }
            if let Some(error) = &self.error {
                map.insert("error".into(), json!(error));
            }
        }
        out
    }
}

enum Origin {
    Conversation(String),
    Channel(String),
    None,
}

/// Where the approval was requested: a WeldAgent conversation (chat panel) or
/// a WeldChat room (`conversationId` then holds the channel id).
async fn resolve_origin(db: &PgPool, id: Option<&str>) -> Result<Origin, sqlx::Error> {
    let Some(id) = id.filter(|i| !i.is_empty()) else {
        return Ok(Origin::None);
    };
    let conversation: Option<String> = sqlx::query_scalar(
        "select id from weldagent_conversations where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    if conversation.is_some() {
        return Ok(Origin::Conversation(id.to_owned()));
    }
    let channel: Option<String> =
        sqlx::query_scalar("select id from chat_channels where id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(channel.map_or(Origin::None, Origin::Channel))
}

/// `persistAssistantMessage`: an assistant message in a conversation, with
/// the conversation's counters moved.
///
/// # Errors
///
/// The tenant database fails.
pub async fn persist_assistant_message(
    db: &PgPool,
    conversation_id: &str,
    content: &str,
    tool_invocations: Option<&Value>,
    metadata: Option<&Value>,
) -> Result<(), sqlx::Error> {
    let ran_tools = tool_invocations
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());
    let trimmed = content.trim();
    let content = if trimmed.is_empty() && !ran_tools {
        "I could not complete that reply. Please try again."
    } else {
        trimmed
    };
    sqlx::query(
        "insert into weldagent_messages (id, conversation_id, role, content, tool_invocations, metadata)
         values ($1, $2, 'assistant', $3, $4::jsonb, $5::jsonb)",
    )
    .bind(generate_id("msg"))
    .bind(conversation_id)
    .bind(content)
    .bind(tool_invocations)
    .bind(metadata)
    .execute(db)
    .await?;
    sqlx::query(
        "update weldagent_conversations
         set last_message_at = $2::timestamptz, message_count = message_count + 1, updated_at = $2::timestamptz
         where id = $1",
    )
    .bind(conversation_id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// The agent's reply that carried this approval in a room (`metadata.approvals`)
/// learns the decision, so its Approve / Reject buttons go away. Never fails.
async fn mark_channel_approval_decided(
    db: &PgPool,
    channel_id: &str,
    approval_id: &str,
    status: &str,
) {
    let result = sqlx::query(
        "update chat_messages
         set metadata = jsonb_set(
             metadata, '{approvals}',
             (select coalesce(jsonb_agg(case when e->>'id' = $2 then e || jsonb_build_object('status', $3::text) else e end), '[]'::jsonb)
              from jsonb_array_elements(metadata->'approvals') e)),
             updated_at = $4::timestamptz
         where channel_id = $1 and metadata @> jsonb_build_object('approvals', jsonb_build_array(jsonb_build_object('id', $2::text)))",
    )
    .bind(channel_id)
    .bind(approval_id)
    .bind(status)
    .bind(now())
    .execute(db)
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "[weldagent/approvals] updating the room message failed");
    }
}

/// `executeDecidedApproval`: run (or decline) the tool call behind a decided
/// approval, and post the outcome where the request came from.
///
/// The conversation case is complete. For a room the message buttons are
/// updated; the outcome reply is posted by the rooms dispatch (part two).
#[allow(clippy::too_many_lines)] // the outcomes of one decision, as TypeScript lists them
pub async fn execute_decided_approval(ctx: &ToolContext, approval: &Value) -> ApprovalExecution {
    let db = &ctx.db;
    let tool_name = approval["toolName"].as_str().unwrap_or_default();
    let args = approval["args"].clone();
    let status = approval["status"].as_str().unwrap_or_default();
    let approval_id = approval["id"].as_str().unwrap_or_default();
    let origin = resolve_origin(db, approval["conversationId"].as_str())
        .await
        .unwrap_or(Origin::None);

    let report = |content: String, invocation: Option<Value>| {
        let origin = &origin;
        async move {
            if let Origin::Conversation(id) = origin {
                let invocations = invocation.map(|i| json!([i]));
                let metadata = json!({ "kind": APPROVAL_OUTCOME_KIND, "approvalId": approval_id });
                if let Err(error) = persist_assistant_message(
                    db,
                    id,
                    &content,
                    invocations.as_ref(),
                    Some(&metadata),
                )
                .await
                {
                    tracing::error!(%error, "[weldagent/approvals] posting outcome failed");
                }
            }
        }
    };

    if let Origin::Channel(channel) = &origin
        && (status == "approved" || status == "rejected")
    {
        mark_channel_approval_decided(db, channel, approval_id, status).await;
    }
    if status != "approved" {
        report(rejected_outcome(tool_name, &args), None).await;
        return ApprovalExecution {
            ran: false,
            ok: true,
            result: None,
            error: None,
        };
    }
    let agent_known = get_agent(db, approval["agentId"].as_str().unwrap_or_default())
        .await
        .ok()
        .flatten();
    let Some(agent) = agent_known else {
        return ApprovalExecution {
            ran: false,
            ok: false,
            result: None,
            error: Some("Agent not found".to_owned()),
        };
    };
    let tool_ctx = ToolContext {
        agent_id: agent["id"].as_str().unwrap_or_default().to_owned(),
        agent_permissions: str_list(&agent, "permissions"),
        enabled_tools: str_list(&agent, "enabledTools"),
        // The approver's grants narrow the agent's; set by the caller.
        ..ctx.clone()
    };
    match execute_tool(&tool_ctx, tool_name, &args).await {
        Err(ToolError::UnknownTool(_)) => {
            let error = "This action is no longer available to this agent, or you lack the permission it needs.";
            report(failed_outcome(tool_name, &args, error), None).await;
            ApprovalExecution {
                ran: false,
                ok: false,
                result: None,
                error: Some(error.to_owned()),
            }
        }
        Err(other) => {
            let message = other.message();
            let invocation = json!({ "toolName": tool_name, "state": "error", "args": args, "result": { "error": message } });
            report(failed_outcome(tool_name, &args, &message), Some(invocation)).await;
            ApprovalExecution {
                ran: true,
                ok: false,
                result: None,
                error: Some(message),
            }
        }
        Ok(result) => {
            let error = result
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let failed_run = error.is_some();
            let invocation = json!({
                "toolName": tool_name,
                "state": if failed_run { "error" } else { "result" },
                "args": args,
                "result": result,
            });
            let note = match &error {
                None => approved_outcome(tool_name, &args, &result),
                Some(error) => failed_outcome(tool_name, &args, error),
            };
            report(note, Some(invocation)).await;
            ApprovalExecution {
                ran: true,
                ok: !failed_run,
                result: Some(result),
                error,
            }
        }
    }
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

// ── Routes ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    status: Option<String>,
}

/// `GET /approvals`: pending approvals (or `status`), of one agent when
/// `agentId` is given, else of the agents the caller can see.
pub(crate) async fn list(caller: Caller, Query(query): Query<ListQuery>) -> Response {
    let agent_id = query.agent_id.as_deref().filter(|a| !a.is_empty());
    let status = query
        .status
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("pending");
    if let Some(agent_id) = agent_id {
        match crate::agent_routes::agent_guard(&caller, agent_id, crate::agent_routes::Mode::Access)
            .await
        {
            Ok(()) => {}
            Err(response) => return response,
        }
    }
    let approvals = match list_approvals(&caller.db, agent_id, Some(status)).await {
        Ok(approvals) => approvals,
        Err(error) => return failed(&error, CONTEXT, "Failed to list approvals"),
    };
    if agent_id.is_some() {
        return Data(approvals).into_response();
    }
    let visible = match crate::agents::list_agents(&caller.db, None, &caller.viewer()).await {
        Ok(agents) => agents,
        Err(error) => return failed(&error, CONTEXT, "Failed to list approvals"),
    };
    let visible: Vec<&str> = visible.iter().filter_map(|a| a["id"].as_str()).collect();
    Data(
        approvals
            .into_iter()
            .filter(|a| {
                a["agentId"]
                    .as_str()
                    .is_some_and(|id| visible.contains(&id))
            })
            .collect::<Vec<_>>(),
    )
    .into_response()
}

/// `POST /approvals/:id/decide`: the agent's owner (its manager), whoever's
/// request raised it, or a holder of `weldagent:manage`.
pub(crate) async fn decide(
    axum::extract::State(state): axum::extract::State<crate::AgentState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    struct Input {
        decision: String,
        reason: Option<String>,
    }
    let data = match validate(&headers, &body, |issues, fields| Input {
        decision: issues
            .choice(
                fields,
                "decision",
                Presence::Required,
                &["approved", "rejected"],
            )
            .into_option()
            .unwrap_or_default(),
        reason: issues
            .text_with(
                fields,
                "reason",
                Presence::Optional,
                Text::length(None, Some(1000)),
            )
            .into_option(),
    }) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let not_found =
        || ApiError::not_found("Approval not found or already decided", None).into_response();
    let result = async {
        let Some(pending) = get_approval(&caller.db, &id).await? else {
            return Ok::<_, sqlx::Error>(Err(not_found()));
        };
        let agent = get_agent(&caller.db, pending["agentId"].as_str().unwrap_or_default()).await?;
        let viewer = caller.viewer();
        // An ownerless (legacy) agent keeps the old rule: anyone who may edit agents.
        let owner = agent
            .as_ref()
            .and_then(|a| a["ownerId"].as_str())
            .filter(|o| !o.is_empty());
        let owner_side = if owner.is_some() {
            can_edit_agent(owner, &viewer)
        } else {
            granter_holds(caller.permissions.resolved(), "weldagent:update")
        };
        let may_decide = viewer.can_manage_all
            || pending["createdBy"].as_str() == Some(viewer.user_id.as_str())
            || owner_side;
        if !may_decide {
            return Ok(Err(ApiError::forbidden()
                .with_message("Only the agent's owner or the person who asked can decide this")
                .into_response()));
        }
        let Some(approval) = decide_approval(
            &caller.db,
            &id,
            &data.decision,
            &caller.user_id,
            data.reason.as_deref(),
        )
        .await?
        else {
            return Ok(Err(not_found()));
        };
        Ok(Ok(approval))
    }
    .await;
    let approval = match result {
        Ok(Ok(approval)) => approval,
        Ok(Err(response)) => return response,
        Err(error) => return failed(&error, CONTEXT, "Failed to decide the approval"),
    };
    let decider_permissions = caller.permissions.resolved().permissions.clone();
    let ctx = ToolContext {
        db: caller.db.clone(),
        agent_id: String::new(),
        actor_user_id: caller.user_id.clone(),
        workspace_id: caller.workspace_id.clone(),
        agent_permissions: Vec::new(),
        enabled_tools: Vec::new(),
        user_timezone: None,
        // Grants narrowed to the approver's.
        actor_permissions: Some(decider_permissions),
        actor_can_edit: None,
        row_scope: None,
        events: Some(crate::tools::EventSink {
            publisher: state.events.clone(),
            context: caller.events.clone(),
        }),
        sandbox: state.sandbox,
    };
    let execution = execute_decided_approval(&ctx, &approval).await;
    let mut out = approval;
    if let Some(map) = out.as_object_mut() {
        map.insert("execution".into(), execution.to_json());
    }
    Data(out).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_follows_the_tool_and_browser_action() {
        assert_eq!(tool_risk_level("create_task", None), "high");
        assert_eq!(tool_risk_level("list_people", None), "low");
        assert_eq!(
            tool_risk_level("browser_act", Some(&json!({ "action": "click" }))),
            "high"
        );
        assert_eq!(
            tool_risk_level("browser_act", Some(&json!({ "action": "screenshot" }))),
            "low"
        );
        assert!(!allows_auto_review("computer_exec"));
        assert!(allows_auto_review("create_task"));
    }

    #[test]
    fn labels_read_in_words() {
        let args = json!({ "title": "QA agent chat task" });
        assert_eq!(
            approval_label("create_task", &args),
            "Create task \"QA agent chat task\""
        );
        assert_eq!(
            approved_outcome("create_task", &args, &json!({ "title": "Real title" })),
            "Approved — created the task \"Real title\"."
        );
        assert_eq!(
            rejected_outcome(
                "create_person",
                &json!({ "firstName": "Ada", "lastName": "Lovelace" })
            ),
            "Rejected — I did not create the person \"Ada Lovelace\"."
        );
        assert_eq!(
            failed_outcome("message_agent", &json!({}), "no room"),
            "Approved, but I could not message the agent: no room"
        );
        assert_eq!(
            approval_label("something_else", &json!({})),
            "Run an action"
        );
    }

    #[test]
    fn long_names_are_cut() {
        let long = "x".repeat(200);
        let label = approval_label("create_task", &json!({ "title": long }));
        assert!(label.ends_with("…\""));
    }

    #[test]
    fn recipients_skip_the_asker_and_system() {
        assert_eq!(
            approval_recipients(Some("owner"), Some("owner"), false),
            Vec::<String>::new()
        );
        assert_eq!(
            approval_recipients(Some("owner"), Some("asker"), true),
            ["owner", "asker"]
        );
        assert_eq!(
            approval_recipients(Some("owner"), Some("system"), true),
            ["owner"]
        );
    }

    #[test]
    fn the_model_is_told_it_is_held() {
        let message = held_for_approval_message("Create task \"X\"");
        assert!(message.starts_with("Held for approval: Create task \"X\"."));
        assert!(message.contains("NOT run yet"));
    }
}
