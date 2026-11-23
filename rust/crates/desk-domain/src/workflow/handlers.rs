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

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_core_domain::js::number_value;
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynRealtimePublisher, RealtimeMessage};
use weldsuite_schema::tenant::{
    helpdesk_agents as agents, helpdesk_articles as articles,
    helpdesk_conversation_messages as messages, helpdesk_conversations as conversations,
    helpdesk_satisfaction_surveys as surveys,
};

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

/// `new Date(Date.now() + ms)` as Drizzle writes it to a `timestamp`
/// column.
fn in_ms(ms: f64) -> Result<PrimitiveDateTime, Thrown> {
    if !ms.is_finite() {
        return Err("Invalid time value".to_owned());
    }
    #[allow(clippy::cast_possible_truncation)] // a finite number of milliseconds
    let nanos = (ms * 1_000_000.0) as i128;
    let at = OffsetDateTime::now_utc()
        .checked_add(time::Duration::nanoseconds_i128(nanos))
        .ok_or_else(|| "Invalid time value".to_owned())?;
    Ok(utc_timestamp(at))
}

/// A bot, system or note entry on a conversation (`helpdesk_conversation_messages`).
struct NewMessage<'a> {
    id: &'a str,
    conversation_id: &'a str,
    content: String,
    author: (&'a str, &'a str, &'a str),
    kind: &'a str,
    is_public: bool,
    is_internal: Option<bool>,
    is_read: Option<bool>,
    metadata: Option<Value>,
}

async fn insert_message(db: &PgPool, message: NewMessage<'_>) -> Result<(), Thrown> {
    let now = utc_now();
    let (author_type, author_id, author_name) = message.author;
    let mut row = messages::ActiveModel {
        id: Set(message.id.to_owned()),
        conversation_id: Set(message.conversation_id.to_owned()),
        content: Set(message.content),
        author_type: Set(author_type.to_owned()),
        author_id: Set(Some(author_id.to_owned())),
        author_name: Set(author_name.to_owned()),
        type_: Set(message.kind.to_owned()),
        is_public: Set(message.is_public),
        status: Set(Some("sent".to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    if let Some(is_internal) = message.is_internal {
        row.is_internal = Set(Some(is_internal));
    }
    if let Some(is_read) = message.is_read {
        row.is_read = Set(is_read);
    }
    if let Some(metadata) = message.metadata {
        row.metadata = Set(Some(metadata));
    }
    messages::Entity::insert(row)
        .exec_without_returning(&orm(db))
        .await
        .map_err(thrown)?;
    Ok(())
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
    insert_message(
        db,
        NewMessage {
            id: &id,
            conversation_id,
            content: content.to_owned(),
            author: ("agent", "workflow", "Bot"),
            kind: "message",
            is_public: true,
            is_internal: Some(false),
            is_read: Some(false),
            metadata: Some(metadata),
        },
    )
    .await?;
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
    let mut found = articles::Entity::find()
        .select_only()
        .column(articles::Column::Id)
        .filter(articles::Column::Status.eq("published"))
        .filter(articles::Column::DeletedAt.is_null())
        .filter(articles::Column::Visibility.eq("public"));
    if !query.is_empty() {
        let pattern = format!("%{}%", escape_like(&query));
        found = found.filter(
            Condition::any()
                .add(crate::list::ilike(articles::Column::Title, &pattern))
                .add(crate::list::ilike(articles::Column::Excerpt, &pattern)),
        );
    }
    let count: Result<Vec<String>, sea_orm::DbErr> = found
        .limit(u64::try_from(limit).unwrap_or(0))
        .into_tuple()
        .all(&orm(&ctx.deps.db))
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
    insert_message(
        &ctx.deps.db,
        NewMessage {
            id: &message_id,
            conversation_id: &conversation_id,
            content: ctx.text("content"),
            author: ("agent", "system", "System"),
            kind: "note",
            is_public: false,
            is_internal: Some(true),
            is_read: None,
            metadata: None,
        },
    )
    .await?;
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
    use agents::Column;
    let orm_db = orm(db);
    let mut available = agents::Entity::find()
        .select_only()
        .columns([Column::Id, Column::UserId, Column::Name])
        .filter(Column::Status.eq("active"))
        .filter(Column::DeletedAt.is_null());
    if let Some(department_id) = department_id {
        available = available.filter(Column::DepartmentId.eq(department_id));
    }
    let load = if round_robin {
        Column::TicketsAssigned
    } else {
        Column::CurrentActiveTickets
    };
    let agent: Option<(String, String, String)> = available
        .order_by_asc(load)
        .into_tuple()
        .one(&orm_db)
        .await
        .map_err(thrown)?;
    let Some((id, user_id, name)) = agent else {
        return Ok(Err("No available agents found".to_owned()));
    };
    // `coalesce(column, 0) + 1`.
    let plus_one = |column: Column| {
        sea_orm::ExprTrait::add(
            Expr::from(Func::coalesce([Expr::col(column), Expr::val(0)])),
            1,
        )
    };
    agents::Entity::update_many()
        .col_expr(Column::TicketsAssigned, plus_one(Column::TicketsAssigned))
        .col_expr(
            Column::CurrentActiveTickets,
            plus_one(Column::CurrentActiveTickets),
        )
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(id.as_str()))
        .exec(&orm_db)
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
    insert_message(
        &ctx.deps.db,
        NewMessage {
            id: &message_id,
            conversation_id,
            content: content.clone(),
            author: ("system", "system", "System"),
            kind: "message",
            is_public: true,
            is_internal: None,
            is_read: None,
            metadata: None,
        },
    )
    .await?;
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
    let at = OffsetDateTime::now_utc();
    let updated_at = iso_timestamp(at);
    let orm_db = orm(&ctx.deps.db);
    let previous: Option<Option<String>> =
        conversations::Entity::find_by_id(conversation_id.as_str())
            .select_only()
            .column(conversations::Column::AssigneeId)
            .into_tuple()
            .one(&orm_db)
            .await
            .map_err(thrown)?;
    let mut update = conversations::Entity::update_many().col_expr(
        conversations::Column::UpdatedAt,
        Expr::value(utc_timestamp(at)),
    );
    for (column, value) in [
        (conversations::Column::AssigneeId, &fields.assignee_id),
        (conversations::Column::AssigneeName, &fields.assignee_name),
        (conversations::Column::DepartmentId, &fields.department_id),
    ] {
        if let Some(value) = value {
            update = update.col_expr(column, Expr::value(value.clone()));
        }
    }
    update
        .filter(conversations::Column::Id.eq(conversation_id.as_str()))
        .exec(&orm_db)
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
    let none = || Expr::value(Option::<String>::None);
    conversations::Entity::update_many()
        .col_expr(conversations::Column::AssigneeId, none())
        .col_expr(conversations::Column::AssigneeName, none())
        .col_expr(conversations::Column::AssigneeAvatar, none())
        .col_expr(conversations::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(conversations::Column::Id.eq(conversation_id.as_str()))
        .exec(&orm(&ctx.deps.db))
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
    let now = utc_now();
    conversations::Entity::update_many()
        .col_expr(conversations::Column::Status, Expr::value("closed"))
        .col_expr(conversations::Column::ClosedAt, Expr::value(now))
        .col_expr(conversations::Column::UpdatedAt, Expr::value(now))
        .filter(conversations::Column::Id.eq(conversation_id.as_str()))
        .exec(&orm(&ctx.deps.db))
        .await
        .map_err(thrown)?;
    Ok(object(
        json!({ "success": true, "conversationId": conversation_id }),
    ))
}

/// The `system:conversation_state_changed` snapshot, when the conversation
/// exists.
async fn publish_state(ctx: &Ctx<'_>, conversation_id: &str) -> Result<(), Thrown> {
    let found = conversations::Entity::find_by_id(conversation_id)
        .one(&orm(&ctx.deps.db))
        .await
        .map_err(thrown)?;
    let Some(row) = found.map(crate::row) else {
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
    let now = utc_now();
    let snoozed_until = if status == "snoozed" && truthy(ctx.input("snoozeDurationMinutes")) {
        Some(in_ms(
            js_number(ctx.input("snoozeDurationMinutes")) * 60_000.0,
        )?)
    } else {
        None
    };
    let mut update = conversations::Entity::update_many()
        .col_expr(conversations::Column::Status, Expr::value(status.clone()))
        .col_expr(conversations::Column::UpdatedAt, Expr::value(now));
    if let Some(snoozed_until) = snoozed_until {
        update = update.col_expr(
            conversations::Column::SnoozedUntil,
            Expr::value(snoozed_until),
        );
    }
    match status.as_str() {
        "resolved" => {
            update = update.col_expr(conversations::Column::ResolvedAt, Expr::value(now));
        }
        "closed" => update = update.col_expr(conversations::Column::ClosedAt, Expr::value(now)),
        _ => {}
    }
    update
        .filter(conversations::Column::Id.eq(conversation_id.as_str()))
        .exec(&orm(&ctx.deps.db))
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
    conversations::Entity::update_many()
        .col_expr(
            conversations::Column::Priority,
            Expr::value(priority.clone()),
        )
        .col_expr(conversations::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(conversations::Column::Id.eq(conversation_id.as_str()))
        .exec(&orm(&ctx.deps.db))
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
    let orm_db = orm(&ctx.deps.db);
    let current: Option<Option<Value>> =
        conversations::Entity::find_by_id(conversation_id.as_str())
            .select_only()
            .column(conversations::Column::Tags)
            .into_tuple()
            .one(&orm_db)
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
    conversations::Entity::update_many()
        .col_expr(
            conversations::Column::Tags,
            Expr::value(Value::Array(tags.clone())),
        )
        .col_expr(conversations::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(conversations::Column::Id.eq(conversation_id.as_str()))
        .exec(&orm_db)
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
        let contact: Option<Option<String>> =
            conversations::Entity::find_by_id(conversation_id.as_str())
                .select_only()
                .column(conversations::Column::ContactId)
                .into_tuple()
                .one(&orm(&ctx.deps.db))
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
    let now = utc_now();
    surveys::Entity::insert(surveys::ActiveModel {
        id: Set(survey_id.clone()),
        ticket_id: Set(ticket_id.to_owned()),
        customer_id: Set(customer_id.clone()),
        status: Set("pending".to_owned()),
        sent_at: Set(now),
        expires_at: Set(Some(in_ms(7.0 * 24.0 * 60.0 * 60.0 * 1000.0)?)),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(&ctx.deps.db))
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
