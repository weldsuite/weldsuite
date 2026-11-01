//! The step handlers `helpdesk-workflow-worker` registers
//! (`src/engine/handlers/index.ts`) and the step executor that runs one
//! (`src/workflows/step-executor.ts`).
//!
//! Fifteen types are registered, plus `ai_agent` as `ai_auto_reply`. The
//! worker has more handler files (`send_notification`, `apply_sla`, …) that
//! it never registers: those step types are skipped, here as there.
//!
//! The handlers write `helpdesk_conversations`, `helpdesk_conversation_messages`,
//! `helpdesk_agents` and `helpdesk_satisfaction_surveys` and publish to the
//! conversation room and the workspace's `helpdesk` topic. The AI steps answer
//! as on Global, where AI is unavailable: they fail and escalate.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_core_domain::js::number_value;
use weldsuite_db::{PgPool, js_row};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynRealtimePublisher, RealtimeMessage};

use super::shared::{
    Scope, as_text, evaluate_condition, is_customer_facing, is_interactive_step, js_number,
    js_string, or, resolve_conversation_id, resolve_inputs, resolve_reference, truthy,
};
use crate::realtime::{conversation_message, conversation_system, defined};

/// What a step came to (`StepOutcome`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOutcome {
    /// `completed`, `waiting_for_input`, `delay`, `failed` or `skipped`.
    #[serde(rename = "type")]
    pub kind: String,
    pub result: Value,
    pub has_new_message: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

impl StepOutcome {
    fn new(kind: &str, result: Value, has_new_message: bool) -> Self {
        Self {
            kind: kind.to_owned(),
            result,
            has_new_message,
            delay_ms: None,
            error: None,
        }
    }

    fn skipped() -> Self {
        Self::new("skipped", json!({ "skipped": true }), false)
    }
}

/// What a step runs against.
#[derive(Clone)]
pub struct StepDeps {
    pub db: PgPool,
    /// `env.REALTIME`; without it nothing is published.
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
}

/// `StepExecutionOptions` without the database and env.
#[derive(Debug, Clone, Copy)]
pub struct StepInput<'a> {
    pub conversation_id: &'a str,
    /// The `workspaceId` the run was started with: the hub key of the
    /// workspace's realtime topics.
    pub workspace_id: &'a str,
    pub execution_id: &'a str,
    pub trigger_data: &'a Value,
    pub step_results: &'a Map<String, Value>,
    pub variables: &'a Map<String, Value>,
}

/// What a handler sees (`StepContext`).
struct Ctx<'a> {
    deps: &'a StepDeps,
    input: StepInput<'a>,
    inputs: Map<String, Value>,
    step_def: &'a Value,
}

/// A handler's failure: the message of what it threw.
type Thrown = String;

fn thrown(error: impl std::fmt::Display) -> Thrown {
    error.to_string()
}

/// `new Date()` as the timestamp text bound with `::timestamp`.
fn now_text() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

fn in_ms(ms: f64) -> Result<String, Thrown> {
    if !ms.is_finite() {
        return Err("Invalid time value".to_owned());
    }
    #[allow(clippy::cast_possible_truncation)] // a finite number of milliseconds
    let nanos = (ms * 1_000_000.0) as i128;
    let at = OffsetDateTime::now_utc()
        .checked_add(time::Duration::nanoseconds_i128(nanos))
        .ok_or_else(|| "Invalid time value".to_owned())?;
    Ok(iso_timestamp(at))
}

async fn publish(deps: &StepDeps, message: RealtimeMessage) {
    if let Some(realtime) = &deps.realtime
        && let Err(error) = realtime.publish_boxed(&message).await
    {
        tracing::warn!(%error, "[helpdesk-workflow] realtime publish failed");
    }
}

/// `rt.helpdeskEvent(workspaceId, event, data)`.
fn helpdesk_event(workspace_id: &str, event: &str, data: Value) -> RealtimeMessage {
    RealtimeMessage::workspace(workspace_id, "helpdesk", event, data, "system")
}

impl Ctx<'_> {
    fn input(&self, key: &str) -> Option<&Value> {
        self.inputs.get(key)
    }

    /// `resolveConversationId(ctx.inputs, triggerData) || state.conversationId`.
    fn conversation_id(&self) -> String {
        resolve_conversation_id(&self.inputs, self.input.trigger_data)
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| self.input.conversation_id.to_owned())
    }

    /// `asText(ctx.inputs[key] || '')`.
    fn text(&self, key: &str) -> String {
        if truthy(self.input(key)) {
            as_text(self.input(key))
        } else {
            String::new()
        }
    }

    fn step_id(&self) -> Option<Value> {
        self.step_def.get("id").cloned()
    }
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/// `executeStepHandler(stepDef, opts)`. `Err` where TypeScript throws
/// outside the handler (an invalid condition pattern): the step is retried.
pub async fn execute_step_handler(
    deps: &StepDeps,
    step_def: &Value,
    input: StepInput<'_>,
) -> Result<StepOutcome, String> {
    let empty = Map::new();
    let scope = Scope {
        previous_results: input.step_results,
        trigger_data: input.trigger_data,
        variables: input.variables,
        contact_data: &empty,
    };
    if let Some(condition) = step_def.get("condition").filter(|c| truthy(Some(c))) {
        let condition = condition.as_object().cloned().unwrap_or_default();
        if !evaluate_condition(&condition, &scope)? {
            return Ok(StepOutcome::skipped());
        }
    }
    let mut raw = Map::new();
    for key in ["config", "inputs"] {
        if let Some(Value::Object(map)) = step_def.get(key) {
            for (k, v) in map {
                raw.insert(k.clone(), v.clone());
            }
        }
    }
    let inputs = resolve_inputs(&raw, &scope);
    let step_type = step_def
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !is_registered(step_type) {
        tracing::warn!(step_type, "[StepExecutor] Unknown step type, skipping");
        return Ok(StepOutcome::skipped());
    }
    let ctx = Ctx {
        deps,
        input,
        inputs,
        step_def,
    };
    let result = match run_handler(step_type, &ctx).await {
        Ok(result) => result,
        Err(message) => {
            return Ok(StepOutcome {
                error: Some(json!(message)),
                ..StepOutcome::new("failed", json!({ "error": message }), false)
            });
        }
    };
    if is_interactive_step(step_type) && truthy(result.get("__waitingForInput")) {
        let mut waiting = Map::new();
        for key in ["messageId", "conversationId"] {
            if let Some(value) = result.get(key) {
                waiting.insert(key.to_owned(), value.clone());
            }
        }
        return Ok(StepOutcome::new(
            "waiting_for_input",
            Value::Object(waiting),
            true,
        ));
    }
    let success = truthy(result.get("success"));
    Ok(StepOutcome {
        error: result.get("error").cloned(),
        ..StepOutcome::new(
            if success { "completed" } else { "failed" },
            Value::Object(result),
            is_customer_facing(step_type) && success,
        )
    })
}

/// The registered step types (`getHandler(type)`).
fn is_registered(step_type: &str) -> bool {
    matches!(
        step_type,
        "send_message"
            | "send_choices"
            | "collect_input"
            | "suggest_articles"
            | "add_internal_note"
            | "ai_auto_reply"
            | "ai_agent"
            | "assign_conversation"
            | "unassign_conversation"
            | "close_conversation"
            | "change_conversation_status"
            | "change_priority"
            | "tag_conversation"
            | "trigger_csat"
            | "delay"
            | "condition"
    )
}

type HandlerResult = Result<Map<String, Value>, Thrown>;

async fn run_handler(step_type: &str, ctx: &Ctx<'_>) -> HandlerResult {
    match step_type {
        "send_message" => send_message(ctx).await,
        "send_choices" => send_choices(ctx).await,
        "collect_input" => collect_input(ctx).await,
        "suggest_articles" => Ok(suggest_articles(ctx).await),
        "add_internal_note" => add_internal_note(ctx).await,
        "assign_conversation" => assign_conversation(ctx).await,
        "unassign_conversation" => unassign_conversation(ctx).await,
        "close_conversation" => close_conversation(ctx).await,
        "change_conversation_status" => change_status(ctx).await,
        "change_priority" => change_priority(ctx).await,
        "tag_conversation" => tag_conversation(ctx).await,
        "trigger_csat" => trigger_csat(ctx).await,
        "delay" => Ok(delay(ctx).await),
        "condition" => condition(ctx),
        // ai_auto_reply, ai_agent
        _ => Ok(object(json!({
            "success": false,
            "error": "AI is currently unavailable",
            "escalated": true,
        }))),
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/// `createBotMessage(db, params)`: a public bot message; its id.
async fn create_bot_message(
    db: &PgPool,
    conversation_id: &str,
    content: &str,
    metadata: Value,
) -> Result<String, Thrown> {
    let id = generate_id("msg");
    sqlx::query(
        "insert into helpdesk_conversation_messages
           (id, conversation_id, content, author_type, author_id, author_name, type, is_public,
            is_internal, status, is_read, metadata, created_at, updated_at)
         values ($1, $2, $3, 'agent', 'workflow', 'Bot', 'message', true, false, 'sent', false, $4,
            $5::timestamp, $5::timestamp)",
    )
    .bind(&id)
    .bind(conversation_id)
    .bind(content)
    .bind(metadata)
    .bind(now_text())
    .execute(db)
    .await
    .map_err(thrown)?;
    Ok(id)
}

async fn send_message(ctx: &Ctx<'_>) -> HandlerResult {
    let content = ctx.text("message");
    if content.is_empty() {
        return Ok(object(json!({ "success": true, "skipped": true })));
    }
    let conversation_id = ctx.input.conversation_id;
    let message_id = create_bot_message(
        &ctx.deps.db,
        conversation_id,
        &content,
        json!({ "workflowId": "", "source": "workflow", "isBot": true }),
    )
    .await?;
    Ok(object(json!({
        "success": true,
        "messageId": message_id,
        "conversationId": conversation_id,
        "content": content,
    })))
}

/// The choices of `send_choices`: `(ctx.inputs.options || []).map(…)`, an
/// option's id defaulting to `opt_` and its value.
fn choice_options(options: Option<&Value>) -> Result<Vec<Value>, Thrown> {
    let options = or(options, None);
    let items = match options {
        None => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err("rawOptions.map is not a function".to_owned()),
    };
    items
        .iter()
        .map(|option| {
            if option.is_null() {
                return Err("Cannot read properties of null (reading 'id')".to_owned());
            }
            let id = option.get("id");
            let id = if truthy(id) {
                id.cloned().unwrap_or_default()
            } else {
                json!(format!("opt_{}", js_string(option.get("value"))))
            };
            Ok(defined(&[
                ("id", Some(id)),
                ("label", option.get("label").cloned()),
                ("value", option.get("value").cloned()),
            ]))
        })
        .collect()
}

async fn send_choices(ctx: &Ctx<'_>) -> HandlerResult {
    let content = ctx.text("message");
    let options = choice_options(ctx.input("options"))?;
    let metadata = defined(&[
        ("interactiveType", Some(json!("choices"))),
        ("workflowExecutionId", Some(json!(ctx.input.execution_id))),
        ("workflowStepId", ctx.step_id()),
        ("options", Some(Value::Array(options))),
        ("source", Some(json!("workflow"))),
    ]);
    let message_id =
        create_bot_message(&ctx.deps.db, ctx.input.conversation_id, &content, metadata).await?;
    Ok(object(json!({
        "__waitingForInput": true,
        "success": true,
        "messageId": message_id,
        "conversationId": ctx.input.conversation_id,
        "stepType": "send_choices",
    })))
}

async fn collect_input(ctx: &Ctx<'_>) -> HandlerResult {
    let content = ctx.text("message");
    let fields = or(ctx.input("fields"), None)
        .cloned()
        .unwrap_or_else(|| json!([]));
    let metadata = defined(&[
        ("interactiveType", Some(json!("collect_input"))),
        ("workflowExecutionId", Some(json!(ctx.input.execution_id))),
        ("workflowStepId", ctx.step_id()),
        ("fields", Some(fields)),
        ("source", Some(json!("workflow"))),
    ]);
    let message_id =
        create_bot_message(&ctx.deps.db, ctx.input.conversation_id, &content, metadata).await?;
    Ok(object(json!({
        "__waitingForInput": true,
        "success": true,
        "messageId": message_id,
        "conversationId": ctx.input.conversation_id,
        "stepType": "collect_input",
    })))
}

/// `escapeLikeTerm(term)`.
fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

async fn suggest_articles(ctx: &Ctx<'_>) -> Map<String, Value> {
    let query = {
        let query = ctx.text("query").trim().to_owned();
        if query.is_empty() {
            ctx.text("searchTerm").trim().to_owned()
        } else {
            query
        }
    };
    let limit = js_number(or(ctx.input("limit"), Some(&json!(3))));
    let failed = || object(json!({ "success": false, "error": "Failed to fetch articles" }));
    // Postgres refuses a LIMIT that is not a whole, non-negative number.
    if !(limit.is_finite() && limit >= 0.0 && limit.fract() == 0.0) {
        return failed();
    }
    #[allow(clippy::cast_possible_truncation)] // whole and finite
    let limit = limit as i64;
    let count: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar(
        "select id from helpdesk_articles
         where status = 'published' and deleted_at is null
           and ($1 = '' or title ilike $2 or excerpt ilike $2)
         limit $3",
    )
    .bind(&query)
    .bind(format!("%{}%", escape_like(&query)))
    .bind(limit)
    .fetch_all(&ctx.deps.db)
    .await;
    match count {
        Ok(rows) => object(json!({ "success": true, "articleCount": rows.len() })),
        Err(error) => {
            tracing::error!(%error, "[SuggestArticles] Failed to fetch articles");
            failed()
        }
    }
}

async fn add_internal_note(ctx: &Ctx<'_>) -> HandlerResult {
    let conversation_id = ctx.conversation_id();
    let message_id = generate_id("msg");
    sqlx::query(
        "insert into helpdesk_conversation_messages
           (id, conversation_id, content, author_type, author_id, author_name, type, is_public,
            is_internal, status, created_at, updated_at)
         values ($1, $2, $3, 'agent', 'system', 'System', 'note', false, true, 'sent',
            $4::timestamp, $4::timestamp)",
    )
    .bind(&message_id)
    .bind(&conversation_id)
    .bind(ctx.text("content"))
    .bind(now_text())
    .execute(&ctx.deps.db)
    .await
    .map_err(thrown)?;
    Ok(object(json!({
        "success": true,
        "messageId": message_id,
        "conversationId": conversation_id,
    })))
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/// The conversation columns an assignment sets.
#[derive(Debug, Default)]
struct Assignment {
    assignee_id: Option<String>,
    assignee_name: Option<String>,
    department_id: Option<String>,
}

/// `pickAgentByLoad(db, strategy, departmentId)`.
async fn pick_agent_by_load(
    db: &PgPool,
    round_robin: bool,
    department_id: Option<&str>,
) -> Result<Result<Assignment, String>, Thrown> {
    let sql = if round_robin {
        "select id, user_id, name from helpdesk_agents
         where status = 'active' and deleted_at is null
           and ($1::text is null or department_id = $1)
         order by tickets_assigned asc limit 1"
    } else {
        "select id, user_id, name from helpdesk_agents
         where status = 'active' and deleted_at is null
           and ($1::text is null or department_id = $1)
         order by current_active_tickets asc limit 1"
    };
    let agent: Option<(String, String, String)> = sqlx::query_as(sql)
        .bind(department_id)
        .fetch_optional(db)
        .await
        .map_err(thrown)?;
    let Some((id, user_id, name)) = agent else {
        return Ok(Err("No available agents found".to_owned()));
    };
    sqlx::query(
        "update helpdesk_agents set
           tickets_assigned = coalesce(tickets_assigned, 0) + 1,
           current_active_tickets = coalesce(current_active_tickets, 0) + 1,
           updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(now_text())
    .execute(db)
    .await
    .map_err(thrown)?;
    Ok(Ok(Assignment {
        assignee_id: Some(user_id),
        assignee_name: Some(name),
        department_id: None,
    }))
}

/// `announceHandoff(...)`: the "joined" system message and `agent_assigned`.
async fn announce_handoff(
    ctx: &Ctx<'_>,
    conversation_id: &str,
    assignee_id: &str,
    assignee_name: Option<&str>,
) -> Result<(), Thrown> {
    let agent_name = assignee_name.unwrap_or("an agent");
    let content = format!("{agent_name} has joined the conversation.");
    let message_id = generate_id("msg");
    let now = now_text();
    sqlx::query(
        "insert into helpdesk_conversation_messages
           (id, conversation_id, content, author_type, author_id, author_name, type, is_public,
            status, created_at, updated_at)
         values ($1, $2, $3, 'system', 'system', 'System', 'message', true, 'sent',
            $4::timestamp, $4::timestamp)",
    )
    .bind(&message_id)
    .bind(conversation_id)
    .bind(&content)
    .bind(&now)
    .execute(&ctx.deps.db)
    .await
    .map_err(thrown)?;
    publish(
        ctx.deps,
        conversation_message(
            conversation_id,
            &message_id,
            &content,
            "system",
            "System",
            "system",
            None,
        ),
    )
    .await;
    publish(
        ctx.deps,
        conversation_system(
            conversation_id,
            "agent_assigned",
            json!({
                "conversationId": conversation_id,
                "agentId": assignee_id,
                "agentName": agent_name,
                "assignedAt": now_iso(),
            }),
        ),
    )
    .await;
    Ok(())
}

/// `new Date().toISOString()`.
fn now_iso() -> String {
    now_text()
}

#[allow(clippy::too_many_lines)] // the handler, step by step
async fn assign_conversation(ctx: &Ctx<'_>) -> HandlerResult {
    let conversation_id = ctx.conversation_id();
    let strategy = {
        let strategy = ctx.text("strategy");
        if strategy.is_empty() {
            "specific_agent".to_owned()
        } else {
            strategy
        }
    };
    let department_id =
        truthy(ctx.input("departmentId")).then(|| as_text(ctx.input("departmentId")));
    let pick = match strategy.as_str() {
        "specific_agent" if truthy(ctx.input("agentId")) => Ok(Assignment {
            assignee_id: Some(as_text(ctx.input("agentId"))),
            assignee_name: truthy(ctx.input("agentName")).then(|| as_text(ctx.input("agentName"))),
            department_id: None,
        }),
        "department" if department_id.is_some() => Ok(Assignment {
            department_id: department_id.clone(),
            ..Assignment::default()
        }),
        "round_robin" | "least_busy" => {
            pick_agent_by_load(
                &ctx.deps.db,
                strategy == "round_robin",
                department_id.as_deref(),
            )
            .await?
        }
        _ => Ok(Assignment::default()),
    };
    let fields = match pick {
        Ok(fields) => fields,
        Err(error) => return Ok(object(json!({ "success": false, "error": error }))),
    };
    let updated_at = now_iso();
    let previous: Option<Option<String>> =
        sqlx::query_scalar("select assignee_id from helpdesk_conversations where id = $1 limit 1")
            .bind(&conversation_id)
            .fetch_optional(&ctx.deps.db)
            .await
            .map_err(thrown)?;
    sqlx::query(
        "update helpdesk_conversations set
           updated_at = $2::timestamp,
           assignee_id = case when $3 then $4 else assignee_id end,
           assignee_name = case when $5 then $6 else assignee_name end,
           department_id = case when $7 then $8 else department_id end
         where id = $1",
    )
    .bind(&conversation_id)
    .bind(&updated_at)
    .bind(fields.assignee_id.is_some())
    .bind(&fields.assignee_id)
    .bind(fields.assignee_name.is_some())
    .bind(&fields.assignee_name)
    .bind(fields.department_id.is_some())
    .bind(&fields.department_id)
    .execute(&ctx.deps.db)
    .await
    .map_err(thrown)?;

    if let Some(assignee) = &fields.assignee_id
        && previous.flatten().as_deref() != Some(assignee.as_str())
    {
        announce_handoff(
            ctx,
            &conversation_id,
            assignee,
            fields.assignee_name.as_deref(),
        )
        .await?;
    }

    let field_values = [
        ("assigneeId", fields.assignee_id.clone().map(Value::String)),
        (
            "assigneeName",
            fields.assignee_name.clone().map(Value::String),
        ),
        (
            "departmentId",
            fields.department_id.clone().map(Value::String),
        ),
    ];
    if fields.assignee_id.is_some() || fields.department_id.is_some() {
        let mut data = vec![("conversationId", Some(json!(conversation_id)))];
        data.extend(field_values.iter().cloned());
        data.push(("updatedAt", Some(json!(now_iso()))));
        publish(
            ctx.deps,
            helpdesk_event(
                ctx.input.workspace_id,
                "conversation_updated",
                defined(&data),
            ),
        )
        .await;
    }

    let mut result = vec![
        ("success", Some(json!(true))),
        ("conversationId", Some(json!(conversation_id))),
        ("strategy", Some(json!(strategy))),
        ("updatedAt", Some(json!(updated_at))),
    ];
    result.extend(field_values);
    Ok(object(defined(&result)))
}

async fn unassign_conversation(ctx: &Ctx<'_>) -> HandlerResult {
    let conversation_id = ctx.conversation_id();
    sqlx::query(
        "update helpdesk_conversations set assignee_id = null, assignee_name = null,
           assignee_avatar = null, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&conversation_id)
    .bind(now_text())
    .execute(&ctx.deps.db)
    .await
    .map_err(thrown)?;
    Ok(object(
        json!({ "success": true, "conversationId": conversation_id }),
    ))
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async fn close_conversation(ctx: &Ctx<'_>) -> HandlerResult {
    let conversation_id = ctx.conversation_id();
    sqlx::query(
        "update helpdesk_conversations set status = 'closed', closed_at = $2::timestamp,
           updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&conversation_id)
    .bind(now_text())
    .execute(&ctx.deps.db)
    .await
    .map_err(thrown)?;
    Ok(object(
        json!({ "success": true, "conversationId": conversation_id }),
    ))
}

/// The `system:conversation_state_changed` snapshot, when the conversation
/// exists.
async fn publish_state(ctx: &Ctx<'_>, conversation_id: &str) -> Result<(), Thrown> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from helpdesk_conversations t where t.id = $1 limit 1",
    )
    .bind(conversation_id)
    .fetch_optional(&ctx.deps.db)
    .await
    .map_err(thrown)?;
    let Some(row) = row.map(js_row) else {
        return Ok(());
    };
    let mut state = Map::new();
    for key in [
        "id",
        "conversationNumber",
        "subject",
        "status",
        "priority",
        "channel",
        "customerName",
        "customerEmail",
        "contactId",
        "assigneeId",
        "assigneeName",
        "assigneeAvatar",
        "departmentId",
        "tags",
        "messageCount",
        "unreadCount",
        "isRead",
    ] {
        state.insert(key.to_owned(), row.get(key).cloned().unwrap_or(Value::Null));
    }
    publish(
        ctx.deps,
        conversation_system(
            conversation_id,
            "system:conversation_state_changed",
            json!({ "conversationId": conversation_id, "conversation": state }),
        ),
    )
    .await;
    Ok(())
}

async fn change_status(ctx: &Ctx<'_>) -> HandlerResult {
    let conversation_id = ctx.conversation_id();
    let status = js_string(ctx.input("status"));
    let now = now_text();
    let snoozed_until = if status == "snoozed" && truthy(ctx.input("snoozeDurationMinutes")) {
        Some(in_ms(
            js_number(ctx.input("snoozeDurationMinutes")) * 60_000.0,
        )?)
    } else {
        None
    };
    sqlx::query(
        "update helpdesk_conversations set
           status = $2, updated_at = $3::timestamp,
           snoozed_until = case when $4::text is null then snoozed_until else $4::timestamp end,
           resolved_at = case when $2 = 'resolved' then $3::timestamp else resolved_at end,
           closed_at = case when $2 = 'closed' then $3::timestamp else closed_at end
         where id = $1",
    )
    .bind(&conversation_id)
    .bind(&status)
    .bind(&now)
    .bind(&snoozed_until)
    .execute(&ctx.deps.db)
    .await
    .map_err(thrown)?;

    if status == "closed" || status == "resolved" {
        publish(
            ctx.deps,
            conversation_system(
                &conversation_id,
                "system:conversation_closed",
                json!({
                    "text": format!("Conversation {status}"),
                    "conversationId": conversation_id,
                    "status": status,
                    "closedAt": now_iso(),
                }),
            ),
        )
        .await;
    }
    publish(
        ctx.deps,
        helpdesk_event(
            ctx.input.workspace_id,
            "conversation:updated",
            json!({ "conversationId": conversation_id, "status": status, "updatedAt": now_iso() }),
        ),
    )
    .await;
    publish_state(ctx, &conversation_id).await?;
    Ok(object(
        json!({ "success": true, "conversationId": conversation_id, "status": status }),
    ))
}

async fn change_priority(ctx: &Ctx<'_>) -> HandlerResult {
    let conversation_id = ctx.conversation_id();
    let priority = js_string(ctx.input("priority"));
    sqlx::query(
        "update helpdesk_conversations set priority = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&conversation_id)
    .bind(&priority)
    .bind(now_text())
    .execute(&ctx.deps.db)
    .await
    .map_err(thrown)?;
    publish_state(ctx, &conversation_id).await?;
    Ok(object(json!({
        "success": true,
        "conversationId": conversation_id,
        "priority": priority,
    })))
}

// ---------------------------------------------------------------------------
// Other
// ---------------------------------------------------------------------------

/// `[...new Set(values)]` for JSON primitives.
fn unique(values: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for value in values {
        if !out
            .iter()
            .any(|known| super::shared::strict_equals(Some(known), Some(&value)))
        {
            out.push(value);
        }
    }
    out
}

async fn tag_conversation(ctx: &Ctx<'_>) -> HandlerResult {
    let conversation_id = ctx.conversation_id();
    let mode = {
        let mode = ctx.text("mode");
        if mode.is_empty() {
            "add".to_owned()
        } else {
            mode
        }
    };
    let input_tags: Vec<Value> = match ctx.input("tags") {
        Some(Value::Array(tags)) => tags.iter().map(|t| json!(js_string(Some(t)))).collect(),
        _ => Vec::new(),
    };
    let current: Option<Option<Value>> =
        sqlx::query_scalar("select tags from helpdesk_conversations where id = $1 limit 1")
            .bind(&conversation_id)
            .fetch_optional(&ctx.deps.db)
            .await
            .map_err(thrown)?;
    let current: Vec<Value> = match current.flatten() {
        Some(Value::Array(tags)) => tags,
        _ => Vec::new(),
    };
    let tags = match mode.as_str() {
        "remove" => current
            .into_iter()
            .filter(|t| !super::shared::includes(&input_tags, Some(t)))
            .collect(),
        "replace" => input_tags,
        _ => unique(current.into_iter().chain(input_tags).collect()),
    };
    sqlx::query(
        "update helpdesk_conversations set tags = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&conversation_id)
    .bind(Value::Array(tags.clone()))
    .bind(now_text())
    .execute(&ctx.deps.db)
    .await
    .map_err(thrown)?;
    Ok(object(json!({
        "success": true,
        "conversationId": conversation_id,
        "mode": mode,
        "tags": tags,
    })))
}

async fn trigger_csat(ctx: &Ctx<'_>) -> HandlerResult {
    let conversation_id = ctx.conversation_id();
    let mut customer_id = "unknown".to_owned();
    if !conversation_id.is_empty() {
        let contact: Option<Option<String>> = sqlx::query_scalar(
            "select contact_id from helpdesk_conversations where id = $1 limit 1",
        )
        .bind(&conversation_id)
        .fetch_optional(&ctx.deps.db)
        .await
        .map_err(thrown)?;
        if let Some(contact) = contact.flatten().filter(|c| !c.is_empty()) {
            customer_id = contact;
        }
    }
    let survey_id = generate_id("csat");
    let ticket_id = if conversation_id.is_empty() {
        "unknown"
    } else {
        conversation_id.as_str()
    };
    sqlx::query(
        "insert into helpdesk_satisfaction_surveys
           (id, ticket_id, customer_id, status, sent_at, expires_at, created_at, updated_at)
         values ($1, $2, $3, 'pending', $4::timestamp, $5::timestamp, $4::timestamp, $4::timestamp)",
    )
    .bind(&survey_id)
    .bind(ticket_id)
    .bind(&customer_id)
    .bind(now_text())
    .bind(in_ms(7.0 * 24.0 * 60.0 * 60.0 * 1000.0)?)
    .execute(&ctx.deps.db)
    .await
    .map_err(thrown)?;
    Ok(object(json!({
        "success": true,
        "surveyId": survey_id,
        "conversationId": conversation_id,
    })))
}

async fn delay(ctx: &Ctx<'_>) -> Map<String, Value> {
    let seconds = js_number(or(
        or(ctx.input("duration"), ctx.input("delaySeconds")),
        Some(&json!(1)),
    ));
    let duration_ms = if seconds.is_nan() {
        f64::NAN
    } else {
        (seconds * 1000.0).min(30_000.0)
    };
    // `setTimeout` waits no time for NaN or a negative delay.
    if duration_ms > 0.0 {
        tokio::time::sleep(Duration::from_secs_f64(duration_ms / 1000.0)).await;
    }
    object(json!({ "success": true, "durationMs": number_value(duration_ms) }))
}

fn condition(ctx: &Ctx<'_>) -> HandlerResult {
    let from_inputs = truthy(ctx.input("field")) && truthy(ctx.input("operator"));
    let source: Map<String, Value> = if from_inputs {
        ctx.inputs.clone()
    } else {
        ctx.step_def
            .get("condition")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    let text = |key: &str| {
        if truthy(source.get(key)) {
            as_text(source.get(key))
        } else {
            String::new()
        }
    };
    let field = text("field");
    let operator = text("operator");
    if field.is_empty() || operator.is_empty() {
        return Ok(object(json!({
            "success": false,
            "error": "Condition missing field or operator",
        })));
    }
    let empty = Map::new();
    let scope = Scope {
        previous_results: ctx.input.step_results,
        trigger_data: ctx.input.trigger_data,
        variables: ctx.input.variables,
        contact_data: &empty,
    };
    // Tracked value: steps., trigger. and variables. only (no contact.).
    let field_value = if field.starts_with("contact.") {
        None
    } else {
        resolve_reference(&field, &scope)
    };
    let mut condition = Map::new();
    condition.insert("field".to_owned(), json!(field));
    condition.insert("operator".to_owned(), json!(operator));
    if let Some(value) = source.get("value") {
        condition.insert("value".to_owned(), value.clone());
    }
    let met = evaluate_condition(&condition, &scope)?;
    Ok(object(defined(&[
        ("success", Some(json!(true))),
        ("branch", Some(json!(if met { "true" } else { "false" }))),
        ("field", Some(json!(field))),
        ("operator", Some(json!(operator))),
        ("evaluatedValue", field_value.cloned()),
    ])))
}
