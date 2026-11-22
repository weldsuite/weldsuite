//! The helpdesk steps (`helpdesk.ts`): assign, tag, status, priority, a
//! reply and an internal note on a conversation.
//!
//! A conversation of the legacy helpdesk (`helpdesk_conversations`) is
//! written here as the worker does. A WeldDesk inbox conversation
//! (`desk_conversations`) goes through [`super::desk`] (the shared inbox
//! of `weldsuite_desk_domain::inbox`), as is `create_conversation`.

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{orm, utc_now, utc_timestamp};
use weldsuite_ports::{RealtimeMessage, Room};
use weldsuite_schema::tenant::{
    desk_conversations, helpdesk_agents as agents, helpdesk_conversation_messages as messages,
    helpdesk_conversations as conversations,
};

use super::{ActionCtx, ActionError, ActionResult};
use crate::js::{as_text, js_string, truthy};

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

fn db_error(error: &DbErr) -> ActionError {
    ActionError::database(error)
}

/// `isDeskConversation(ctx, id)`.
async fn is_desk_conversation(ctx: &ActionCtx<'_>, id: &str) -> Result<bool, ActionError> {
    let row: Option<String> = desk_conversations::Entity::find()
        .select_only()
        .column(desk_conversations::Column::Id)
        .filter(desk_conversations::Column::Id.eq(id))
        .into_tuple()
        .one(&orm(ctx.db))
        .await
        .map_err(|e| db_error(&e))?;
    Ok(row.is_some())
}

/// The conversation a step acts on.
enum Target {
    /// A legacy helpdesk conversation.
    Legacy(String),
    /// A WeldDesk inbox conversation ([`super::desk`]).
    Desk(String),
    /// No conversation id: the step's answer.
    Answer(Value),
}

/// The conversation to act on, and which inbox it is in.
async fn target(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> Result<Target, ActionError> {
    let Some(id) = conversation_id(inputs, ctx) else {
        return Ok(Target::Answer(no_conversation()));
    };
    if is_desk_conversation(ctx, &id).await? {
        return Ok(Target::Desk(id));
    }
    Ok(Target::Legacy(id))
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

/// `pickAgentByLoad(ctx, strategy, departmentId)`.
async fn pick_agent(
    ctx: &ActionCtx<'_>,
    by_assigned: bool,
    department: Option<&str>,
) -> Result<Option<(Option<String>, Option<String>)>, ActionError> {
    let db = orm(ctx.db);
    let mut available = agents::Entity::find()
        .select_only()
        .columns([
            agents::Column::Id,
            agents::Column::UserId,
            agents::Column::Name,
        ])
        .filter(agents::Column::Status.eq("active"))
        .filter(agents::Column::DeletedAt.is_null());
    if let Some(department) = department {
        available = available.filter(agents::Column::DepartmentId.eq(department));
    }
    let row: Option<(String, Option<String>, Option<String>)> = available
        .order_by_asc(if by_assigned {
            agents::Column::TicketsAssigned
        } else {
            agents::Column::CurrentActiveTickets
        })
        .into_tuple()
        .one(&db)
        .await
        .map_err(|e| db_error(&e))?;
    let Some((id, user_id, name)) = row else {
        return Ok(None);
    };
    // `coalesce(<column>, 0) + 1`.
    let one_more = |column: agents::Column| -> Expr {
        sea_orm::ExprTrait::add(Func::coalesce([Expr::col(column), Expr::val(0)]), 1)
    };
    agents::Entity::update_many()
        .col_expr(
            agents::Column::TicketsAssigned,
            one_more(agents::Column::TicketsAssigned),
        )
        .col_expr(
            agents::Column::CurrentActiveTickets,
            one_more(agents::Column::CurrentActiveTickets),
        )
        .col_expr(agents::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(agents::Column::Id.eq(&id))
        .exec(&db)
        .await
        .map_err(|e| db_error(&e))?;
    Ok(Some((user_id, name)))
}

pub(super) async fn assign_conversation(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let id = match target(inputs, ctx).await? {
        Target::Legacy(id) => id,
        Target::Desk(id) => return super::desk::assign(ctx, &id, inputs).await,
        Target::Answer(answer) => return Ok(answer),
    };
    let strategy = text_or(inputs.get("strategy"), "specific_agent");
    let department = inputs
        .get("departmentId")
        .filter(|v| truthy(v))
        .map(|v| as_text(Some(v)));
    let at = OffsetDateTime::now_utc();
    let now = weldsuite_events::iso_timestamp(at);
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
    let mut assign = conversations::Entity::update_many().col_expr(
        conversations::Column::UpdatedAt,
        Expr::value(utc_timestamp(at)),
    );
    if let Some(agent) = &assignee {
        assign = assign.col_expr(
            conversations::Column::AssigneeId,
            Expr::value(agent.as_str()),
        );
    }
    if let Some(name) = &assignee_name {
        assign = assign.col_expr(
            conversations::Column::AssigneeName,
            Expr::value(name.as_str()),
        );
    }
    // `coalesce($department, department_id)`.
    if let Some(department) = &set_department {
        assign = assign.col_expr(conversations::Column::DepartmentId, Expr::value(department));
    }
    assign
        .filter(conversations::Column::Id.eq(&id))
        .exec(&orm(ctx.db))
        .await
        .map_err(|e| db_error(&e))?;
    if let Some(agent) = assignee.as_ref().filter(|a| truthy(a)) {
        let name = assignee_name
            .clone()
            .filter(truthy)
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
    let target = target(inputs, ctx).await?;
    if let Target::Answer(answer) = target {
        return Ok(answer);
    }
    let mode = text_or(inputs.get("mode"), "add");
    let wanted: Vec<String> = match inputs.get("tags") {
        Some(Value::Array(items)) => items.iter().map(|t| js_string(Some(t))).collect(),
        _ => Vec::new(),
    };
    let id = match target {
        Target::Desk(id) => return super::desk::tag(ctx, &id, &mode, wanted).await,
        Target::Legacy(id) => id,
        Target::Answer(answer) => return Ok(answer),
    };
    let db = orm(ctx.db);
    let current: Option<Option<Value>> = conversations::Entity::find()
        .select_only()
        .column(conversations::Column::Tags)
        .filter(conversations::Column::Id.eq(&id))
        .into_tuple()
        .one(&db)
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
    conversations::Entity::update_many()
        .col_expr(conversations::Column::Tags, Expr::value(json!(next)))
        .col_expr(conversations::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(conversations::Column::Id.eq(&id))
        .exec(&db)
        .await
        .map_err(|e| db_error(&e))?;
    Ok(json!({ "success": true, "conversationId": id, "mode": mode, "tags": next }))
}

pub(super) async fn change_status(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let id = target(inputs, ctx).await?;
    let status = match inputs.get("status") {
        None => "undefined".to_owned(),
        some => js_string(some),
    };
    let id = match id {
        Target::Desk(id) => return super::desk::change_state(ctx, &id, &status).await,
        Target::Legacy(id) => id,
        Target::Answer(answer) => return Ok(answer),
    };
    let now = utc_now();
    let mut update = conversations::Entity::update_many()
        .col_expr(conversations::Column::Status, Expr::value(&status))
        .col_expr(conversations::Column::UpdatedAt, Expr::value(now));
    if status == "resolved" {
        update = update.col_expr(conversations::Column::ResolvedAt, Expr::value(now));
    }
    if status == "closed" {
        update = update.col_expr(conversations::Column::ClosedAt, Expr::value(now));
    }
    update
        .filter(conversations::Column::Id.eq(&id))
        .exec(&orm(ctx.db))
        .await
        .map_err(|e| db_error(&e))?;
    Ok(json!({ "success": true, "conversationId": id, "status": status }))
}

pub(super) async fn change_priority(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let id = target(inputs, ctx).await?;
    let priority = match inputs.get("priority") {
        None => "undefined".to_owned(),
        some => js_string(some),
    };
    let id = match id {
        Target::Desk(id) => return super::desk::set_priority(ctx, &id, &priority).await,
        Target::Legacy(id) => id,
        Target::Answer(answer) => return Ok(answer),
    };
    conversations::Entity::update_many()
        .col_expr(conversations::Column::Priority, Expr::value(&priority))
        .col_expr(conversations::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(conversations::Column::Id.eq(&id))
        .exec(&orm(ctx.db))
        .await
        .map_err(|e| db_error(&e))?;
    Ok(json!({ "success": true, "conversationId": id, "priority": priority }))
}

pub(super) async fn send_reply(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let id = match target(inputs, ctx).await? {
        Target::Legacy(id) => id,
        Target::Desk(id) => {
            let body = text_or(inputs.get("message"), "");
            return super::desk::add_message(ctx, &id, "message", &body).await;
        }
        Target::Answer(answer) => return Ok(answer),
    };
    let message_id = weldsuite_kit::generate_id("msg");
    let author_type = text_or(inputs.get("authorType"), "system");
    let content = text_or(inputs.get("message"), "");
    let agent = author_type == "agent";
    let now = utc_now();
    let db = orm(ctx.db);
    messages::Entity::insert(messages::ActiveModel {
        id: Set(message_id.clone()),
        conversation_id: Set(id.clone()),
        content: Set(content.clone()),
        author_type: Set(author_type.clone()),
        author_id: Set(Some(if agent {
            ctx.info.user_id.clone()
        } else {
            "system".to_owned()
        })),
        author_name: Set(if agent { "Agent" } else { "System" }.to_owned()),
        type_: Set("message".to_owned()),
        is_public: Set(true),
        status: Set(Some("sent".to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await
    .map_err(|e| db_error(&e))?;
    conversations::Entity::update_many()
        .col_expr(conversations::Column::LastMessageAt, Expr::value(now))
        .col_expr(conversations::Column::LastAgentMessageAt, Expr::value(now))
        .col_expr(conversations::Column::UpdatedAt, Expr::value(now))
        .filter(conversations::Column::Id.eq(&id))
        .exec(&db)
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
        Target::Legacy(id) => id,
        Target::Desk(id) => {
            let body = match inputs.get("content").filter(|v| truthy(v)) {
                Some(content) => as_text(Some(content)),
                None => text_or(inputs.get("note"), ""),
            };
            return super::desk::add_message(ctx, &id, "note", &body).await;
        }
        Target::Answer(answer) => return Ok(answer),
    };
    let message_id = weldsuite_kit::generate_id("msg");
    let now = utc_now();
    messages::Entity::insert(messages::ActiveModel {
        id: Set(message_id.clone()),
        conversation_id: Set(id.clone()),
        content: Set(text_or(inputs.get("content"), "")),
        author_type: Set("agent".to_owned()),
        author_id: Set(Some(ctx.info.user_id.clone())),
        author_name: Set("System".to_owned()),
        type_: Set("note".to_owned()),
        is_public: Set(false),
        is_internal: Set(Some(true)),
        status: Set(Some("sent".to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(ctx.db))
    .await
    .map_err(|e| db_error(&e))?;
    Ok(json!({ "success": true, "messageId": message_id, "conversationId": id }))
}
