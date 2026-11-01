//! The helpdesk steps (`helpdesk.ts`): assign, tag, status, priority, a
//! reply and an internal note on a conversation.
//!
//! A conversation of the legacy helpdesk (`helpdesk_conversations`) is
//! written here as the worker does. A WeldDesk inbox conversation
//! (`desk_conversations`) goes through `@weldsuite/desk-domain/inbox` on
//! Global, which the Rust backend does not have yet: such a step fails,
//! without retries, saying so. `create_conversation` opens an inbox
//! conversation, so it fails the same way.

use serde_json::{Map, Value, json};
use weldsuite_ports::{RealtimeMessage, Room};

use super::{ActionCtx, ActionError, ActionResult};
use crate::js::{as_text, js_string, truthy};

const DESK_NOT_YET: &str =
    "WeldDesk inbox conversations can't be changed by a workflow on this deployment yet";

/// `resolveConversationId(inputs, ctx)`.
fn conversation_id(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> Option<String> {
    if let Some(id) = inputs.get("conversationId").filter(|v| truthy(v)) {
        return Some(as_text(Some(id)));
    }
    let trigger = ctx.trigger_data;
    let entity_type = trigger.get("entityType").and_then(Value::as_str);
    if matches!(
        entity_type,
        Some("helpdesk_conversation" | "desk_conversation")
    ) {
        return Some(js_string(trigger.get("entityId")));
    }
    match trigger.get("data") {
        Some(Value::Object(data)) if data.contains_key("conversationId") => {
            Some(js_string(data.get("conversationId")))
        }
        _ => None,
    }
}

fn no_conversation() -> Value {
    json!({ "success": false, "error": "No conversation ID" })
}

fn db_error(error: &sqlx::Error) -> ActionError {
    ActionError::plain(&error.to_string())
}

/// `isDeskConversation(ctx, id)`.
async fn is_desk_conversation(ctx: &ActionCtx<'_>, id: &str) -> Result<bool, ActionError> {
    let row: Option<String> =
        sqlx::query_scalar("select id from desk_conversations where id = $1 limit 1")
            .bind(id)
            .fetch_optional(ctx.db)
            .await
            .map_err(|e| db_error(&e))?;
    Ok(row.is_some())
}

/// The conversation to act on, or the step's answer without one.
async fn target(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> Result<Result<String, Value>, ActionError> {
    let Some(id) = conversation_id(inputs, ctx) else {
        return Ok(Err(no_conversation()));
    };
    if is_desk_conversation(ctx, &id).await? {
        return Err(ActionError::fatal(DESK_NOT_YET));
    }
    Ok(Ok(id))
}

/// `publishRealtime(env, workspaceId, 'conversation:<id>', event, data)`.
async fn publish_conversation(ctx: &ActionCtx<'_>, id: &str, event: &str, data: Value) {
    let Some(realtime) = &ctx.deps.realtime else {
        return;
    };
    let mut payload = Map::new();
    payload.insert("type".into(), json!(event));
    if let Value::Object(fields) = data {
        payload.extend(fields);
    }
    payload.insert("ts".into(), json!(super::now_ms()));
    let message = RealtimeMessage::room(Room::Conversation, id, Value::Object(payload));
    if let Err(error) = realtime.publish_boxed(&message).await {
        tracing::warn!(%error, "[Realtime] Failed to publish {event}");
    }
}

fn text_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(v) if truthy(v) => as_text(Some(v)),
        _ => fallback.to_owned(),
    }
}

pub(super) async fn create_conversation(
    _inputs: &Map<String, Value>,
    _ctx: &ActionCtx<'_>,
) -> ActionResult {
    Err(ActionError::fatal(
        "Opening a WeldDesk inbox conversation from a workflow is not available on this deployment yet",
    ))
}

/// `pickAgentByLoad(ctx, strategy, departmentId)`.
async fn pick_agent(
    ctx: &ActionCtx<'_>,
    by_assigned: bool,
    department: Option<&str>,
) -> Result<Option<(Option<String>, Option<String>)>, ActionError> {
    let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, user_id, name from helpdesk_agents
         where status = 'active' and deleted_at is null and ($1::text is null or department_id = $1)
         order by case when $2 then tickets_assigned else current_active_tickets end asc
         limit 1",
    )
    .bind(department)
    .bind(by_assigned)
    .fetch_optional(ctx.db)
    .await
    .map_err(|e| db_error(&e))?;
    let Some((id, user_id, name)) = row else {
        return Ok(None);
    };
    sqlx::query(
        "update helpdesk_agents set tickets_assigned = coalesce(tickets_assigned, 0) + 1,
           current_active_tickets = coalesce(current_active_tickets, 0) + 1, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(super::now_text())
    .execute(ctx.db)
    .await
    .map_err(|e| db_error(&e))?;
    Ok(Some((user_id, name)))
}

pub(super) async fn assign_conversation(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let id = match target(inputs, ctx).await? {
        Ok(id) => id,
        Err(answer) => return Ok(answer),
    };
    let strategy = text_or(inputs.get("strategy"), "specific_agent");
    let department = inputs
        .get("departmentId")
        .filter(|v| truthy(v))
        .map(|v| as_text(Some(v)));
    let now = super::now_text();
    // `updateData`, in its key order: updatedAt, then what the strategy set.
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now));
    let mut assignee: Option<Value> = None;
    let mut assignee_name: Option<Value> = None;
    let mut set_department: Option<String> = None;
    if strategy == "specific_agent" && inputs.get("agentId").is_some_and(truthy) {
        assignee = Some(json!(as_text(inputs.get("agentId"))));
        if let Some(name) = inputs.get("agentName").filter(|v| truthy(v)) {
            assignee_name = Some(json!(as_text(Some(name))));
        }
    } else if strategy == "department" && department.is_some() {
        set_department.clone_from(&department);
    } else if strategy == "round_robin" || strategy == "least_busy" {
        let Some((user, name)) =
            pick_agent(ctx, strategy == "round_robin", department.as_deref()).await?
        else {
            return Ok(json!({ "success": false, "error": "No available agents" }));
        };
        assignee = Some(user.map_or(Value::Null, Value::String));
        assignee_name = Some(name.map_or(Value::Null, Value::String));
    }
    sqlx::query(
        "update helpdesk_conversations set updated_at = $2::timestamp,
           assignee_id = case when $3 then $4 else assignee_id end,
           assignee_name = case when $5 then $6 else assignee_name end,
           department_id = coalesce($7, department_id)
         where id = $1",
    )
    .bind(&id)
    .bind(&now)
    .bind(assignee.is_some())
    .bind(assignee.as_ref().and_then(Value::as_str))
    .bind(assignee_name.is_some())
    .bind(assignee_name.as_ref().and_then(Value::as_str))
    .bind(set_department.as_deref())
    .execute(ctx.db)
    .await
    .map_err(|e| db_error(&e))?;
    if let Some(agent) = assignee.as_ref().filter(|a| truthy(a)) {
        let name = assignee_name
            .clone()
            .filter(|n| truthy(n))
            .unwrap_or_else(|| json!("Agent"));
        publish_conversation(
            ctx,
            &id,
            "agent:assigned",
            json!({ "conversationId": id, "agentId": agent, "agentName": name }),
        )
        .await;
    }
    if let Some(agent) = assignee {
        update.insert("assigneeId".into(), agent);
    }
    if let Some(name) = assignee_name {
        update.insert("assigneeName".into(), name);
    }
    if let Some(department) = set_department {
        update.insert("departmentId".into(), json!(department));
    }
    let mut out = json!({ "success": true, "conversationId": id, "strategy": strategy });
    for (key, value) in update {
        out[key] = value;
    }
    Ok(out)
}

pub(super) async fn tag_conversation(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let id = match target(inputs, ctx).await? {
        Ok(id) => id,
        Err(answer) => return Ok(answer),
    };
    let mode = text_or(inputs.get("mode"), "add");
    let wanted: Vec<String> = match inputs.get("tags") {
        Some(Value::Array(items)) => items.iter().map(|t| js_string(Some(t))).collect(),
        _ => Vec::new(),
    };
    let current: Option<Option<Value>> =
        sqlx::query_scalar("select tags from helpdesk_conversations where id = $1 limit 1")
            .bind(&id)
            .fetch_optional(ctx.db)
            .await
            .map_err(|e| db_error(&e))?;
    let current: Vec<String> = match current.flatten() {
        Some(Value::Array(items)) => items.iter().map(|t| js_string(Some(t))).collect(),
        _ => Vec::new(),
    };
    let next: Vec<String> = match mode.as_str() {
        "remove" => current
            .into_iter()
            .filter(|t| !wanted.contains(t))
            .collect(),
        "replace" => wanted,
        _ => {
            let mut all = current;
            for tag in wanted {
                if !all.contains(&tag) {
                    all.push(tag);
                }
            }
            all
        }
    };
    sqlx::query(
        "update helpdesk_conversations set tags = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&id)
    .bind(json!(next))
    .bind(super::now_text())
    .execute(ctx.db)
    .await
    .map_err(|e| db_error(&e))?;
    Ok(json!({ "success": true, "conversationId": id, "mode": mode, "tags": next }))
}

pub(super) async fn change_status(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let id = match target(inputs, ctx).await? {
        Ok(id) => id,
        Err(answer) => return Ok(answer),
    };
    let status = match inputs.get("status") {
        None => "undefined".to_owned(),
        some => js_string(some),
    };
    let now = super::now_text();
    sqlx::query(
        "update helpdesk_conversations set status = $2, updated_at = $3::timestamp,
           resolved_at = case when $2 = 'resolved' then $3::timestamp else resolved_at end,
           closed_at = case when $2 = 'closed' then $3::timestamp else closed_at end
         where id = $1",
    )
    .bind(&id)
    .bind(&status)
    .bind(&now)
    .execute(ctx.db)
    .await
    .map_err(|e| db_error(&e))?;
    Ok(json!({ "success": true, "conversationId": id, "status": status }))
}

pub(super) async fn change_priority(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let id = match target(inputs, ctx).await? {
        Ok(id) => id,
        Err(answer) => return Ok(answer),
    };
    let priority = match inputs.get("priority") {
        None => "undefined".to_owned(),
        some => js_string(some),
    };
    sqlx::query(
        "update helpdesk_conversations set priority = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&id)
    .bind(&priority)
    .bind(super::now_text())
    .execute(ctx.db)
    .await
    .map_err(|e| db_error(&e))?;
    Ok(json!({ "success": true, "conversationId": id, "priority": priority }))
}

pub(super) async fn send_reply(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let id = match target(inputs, ctx).await? {
        Ok(id) => id,
        Err(answer) => return Ok(answer),
    };
    let message_id = weldsuite_kit::generate_id("msg");
    let author_type = text_or(inputs.get("authorType"), "system");
    let content = text_or(inputs.get("message"), "");
    let agent = author_type == "agent";
    let now = super::now_text();
    sqlx::query(
        "insert into helpdesk_conversation_messages (id, conversation_id, content, author_type,
           author_id, author_name, type, is_public, status, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'message', true, 'sent', $7::timestamp, $7::timestamp)",
    )
    .bind(&message_id)
    .bind(&id)
    .bind(&content)
    .bind(&author_type)
    .bind(if agent {
        ctx.info.user_id.as_str()
    } else {
        "system"
    })
    .bind(if agent { "Agent" } else { "System" })
    .bind(&now)
    .execute(ctx.db)
    .await
    .map_err(|e| db_error(&e))?;
    sqlx::query(
        "update helpdesk_conversations set last_message_at = $2::timestamp,
           last_agent_message_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(&id)
    .bind(&now)
    .execute(ctx.db)
    .await
    .map_err(|e| db_error(&e))?;
    publish_conversation(
        ctx,
        &id,
        "message:new",
        json!({
            "id": message_id,
            "conversationId": id,
            "content": content,
            "sender": "agent",
            "timestamp": super::now_text(),
        }),
    )
    .await;
    Ok(json!({ "success": true, "messageId": message_id, "conversationId": id }))
}

pub(super) async fn add_internal_note(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let id = match target(inputs, ctx).await? {
        Ok(id) => id,
        Err(answer) => return Ok(answer),
    };
    let message_id = weldsuite_kit::generate_id("msg");
    let now = super::now_text();
    sqlx::query(
        "insert into helpdesk_conversation_messages (id, conversation_id, content, author_type,
           author_id, author_name, type, is_public, is_internal, status, created_at, updated_at)
         values ($1, $2, $3, 'agent', $4, 'System', 'note', false, true, 'sent', $5::timestamp, $5::timestamp)",
    )
    .bind(&message_id)
    .bind(&id)
    .bind(text_or(inputs.get("content"), ""))
    .bind(&ctx.info.user_id)
    .bind(&now)
    .execute(ctx.db)
    .await
    .map_err(|e| db_error(&e))?;
    Ok(json!({ "success": true, "messageId": message_id, "conversationId": id }))
}
