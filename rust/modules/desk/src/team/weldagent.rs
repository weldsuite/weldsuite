//! `/api/helpdesk-weldagent` (`routes/helpdesk-weldagent/index.ts`): the
//! records of conversations the AI agent handled. AI is gone, so GET/POST
//! `/config` answer 503 (POST after its body is validated). Permissions
//! `settings:read|update`, `conversations:create|read|update`.
//!
//! TypeScript quirks kept: `page` and `pageSize` go through `Number(...)`
//! (`NaN` and `Infinity` are `null` in the JSON), Drizzle leaves out a
//! `NaN` or negative LIMIT and a falsy OFFSET (a negative offset is the
//! route's 500); the lists order by `updated_at` alone; `ai-resolved` drops
//! escalated rows after paging; convert-to-ticket writes `category: null`
//! (NOT NULL: the route's 500 without one).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_desk_domain::notify::EntityKind;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text, js_number};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::{js_number as json_number, js_number_text, js_substring};
use crate::crud::write_failed;
use crate::js::{query_param, text};
use crate::notify::{Assigned, assigned};
use crate::table::Table;
use crate::tables::{HELPDESK_CONVERSATION_MESSAGES, HELPDESK_CONVERSATIONS, HELPDESK_TICKETS};
use crate::tickets::base36_now;
use crate::{Caller, DeskState, Refusal, now, validate};

const CONV: &Table = &HELPDESK_CONVERSATIONS;
const MESSAGES: &Table = &HELPDESK_CONVERSATION_MESSAGES;

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::CONVERSATIONS_READ.to_owned()]);
    let update = || gate.require([perm::CONVERSATIONS_UPDATE.to_owned()]);
    Router::new()
        .route(
            "/config",
            get(get_config).route_layer(gate.require([perm::SETTINGS_READ.to_owned()])),
        )
        .route(
            "/config",
            post(save_config).route_layer(gate.require([perm::SETTINGS_UPDATE.to_owned()])),
        )
        .route(
            "/conversations",
            post(create).route_layer(gate.require([perm::CONVERSATIONS_CREATE.to_owned()])),
        )
        .route(
            "/conversations/ai-active",
            get(ai_active).route_layer(read()),
        )
        .route(
            "/conversations/ai-resolved",
            get(ai_resolved).route_layer(read()),
        )
        .route("/conversations/pending", get(pending).route_layer(read()))
        .route("/conversations/{id}", get(detail).route_layer(read()))
        .route(
            "/conversations/{id}/messages",
            post(send_message).route_layer(update()),
        )
        .route(
            "/conversations/{id}/transfer-to-human",
            post(transfer).route_layer(update()),
        )
        .route(
            "/conversations/{id}/accept",
            post(accept).route_layer(update()),
        )
        .route(
            "/conversations/{id}/convert-to-ticket",
            post(convert).route_layer(update()),
        )
}

// ── config (removed) ────────────────────────────────────────────────────────

fn unavailable() -> Response {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "ai_unavailable",
        "AI is currently unavailable",
    )
    .into_response()
}

async fn get_config() -> Response {
    unavailable()
}

/// `z.record(z.boolean())` at `key`.
fn boolean_record(issues: &mut Issues, fields: &Map<String, Value>, key: &str) {
    issues.nested(fields, key, Presence::Optional, |issues, map| {
        for name in map.keys() {
            issues.boolean(map, name, Presence::Required);
        }
    });
}

/// `saveConfigSchema`, then 503.
async fn save_config(headers: HeaderMap, body: Bytes) -> Response {
    let opt = Presence::Optional;
    let checked = validate(&headers, &body, |issues, fields| {
        issues.text(fields, "name", opt, None, Some(50));
        issues.text(fields, "logoUrl", Presence::Nullish, None, Some(500));
        issues.text(fields, "systemInstructions", opt, None, None);
        boolean_record(issues, fields, "knowledgePermissions");
        issues.nested(fields, "escalationSettings", opt, |_, _| ());
        issues.boolean(fields, "isActive", opt);
        issues.text(fields, "welcomeMessage", opt, None, None);
        issues.boolean(fields, "allowHumanEscalation", opt);
        issues.text(fields, "greetingMessage", opt, None, None);
        issues.text(fields, "agentDefinitionId", opt, None, None);
        issues.list(fields, "enabledBuiltinTools", opt, None, None, |issues, item| {
            issues.item_text(item, Text::default())
        });
        issues.number(fields, "maxIterations", opt, Number::default());
        issues.number(fields, "maxTotalTokens", opt, Number::default());
        issues.choice(
            fields,
            "onEscalation",
            opt,
            &["assign_round_robin", "assign_least_busy", "notify_only"],
        );
        issues.choice(
            fields,
            "onResolution",
            opt,
            &["auto_close", "mark_resolved", "do_nothing"],
        );
        issues.choice(
            fields,
            "onFailure",
            opt,
            &["assign_and_apologize", "notify_only"],
        );
        issues.text(fields, "apologyMessage", opt, None, None);
    });
    match checked {
        Ok(()) => unavailable(),
        Err(refusal) => refusal.respond("Internal server error"),
    }
}

// ── create ──────────────────────────────────────────────────────────────────

async fn create(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to create AI conversation";
    let opt = Presence::Optional;
    let read = validate(&headers, &body, |issues, fields| {
        let session = issues.text(fields, "sessionId", Presence::Required, Some(1), None);
        let email = issues.text_with(
            fields,
            "customerEmail",
            opt,
            Text {
                format: Some(Format::Email),
                ..Text::default()
            },
        );
        let name = issues.text(fields, "customerName", opt, None, None);
        let context = issues.nested(fields, "conversationContext", opt, |_, map| map.clone());
        (
            session.into_option().unwrap_or_default(),
            email.into_option(),
            name.into_option(),
            context.into_option(),
        )
    });
    let (session_id, email, name, context) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let id = generate_id("conv");
    let number = format!("CONV-{}", base36_now());
    let now = now();
    // `{ sessionId, ...conversationContext }`: the context's keys win.
    let mut metadata = Map::new();
    metadata.insert("sessionId".to_owned(), json!(session_id));
    if let Some(context) = context {
        metadata.extend(context);
    }
    let mut values = Map::new();
    let mut set = |prop: &str, value: Value| CONV.set(&mut values, prop, value);
    set("id", json!(id));
    set("conversationNumber", json!(number));
    set("subject", json!("AI Conversation"));
    set("status", json!("active"));
    set("channel", json!("chat"));
    set("customerEmail", json!(email));
    set("customerName", json!(name.unwrap_or_else(|| "Visitor".to_owned())));
    set("assigneeId", json!("ai-agent"));
    set("assigneeName", json!("WeldAgent"));
    set("messageCount", json!(0));
    set("unreadCount", json!(0));
    set("isRead", json!(true));
    set("isStarred", json!(false));
    set("isArchived", json!(false));
    set("hasAttachments", json!(false));
    set("tags", json!(["ai-managed"]));
    set("metadata", Value::Object(metadata));
    set("createdAt", json!(now));
    set("updatedAt", json!(now));
    if let Err(error) = CONV
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    caller.publish(
        &state,
        ev::HELPDESK_CONVERSATION_CREATED,
        &id,
        &json!({ "id": id, "conversationNumber": number }),
    );
    Created(json!({
        "id": id,
        "conversationNumber": number,
        "subject": "AI Conversation",
        "status": "active",
        "assigneeId": "ai-agent",
        "createdAt": now,
    }))
    .into_response()
}

// ── lists ───────────────────────────────────────────────────────────────────

/// `$1` the search term (or null), `$2` LIMIT, `$3` OFFSET (null for none;
/// text, as the driver sends a JavaScript number).
const ACTIVE: (&str, &str) = (
    "select count(*)::int from helpdesk_conversations t
     where t.deleted_at is null and t.assignee_id = 'ai-agent' and t.status in ('active', 'pending')
       and ($1::text is null or (t.subject ilike $1 or t.customer_name ilike $1 or t.customer_email ilike $1))",
    "select to_jsonb(t) from helpdesk_conversations t
     where t.deleted_at is null and t.assignee_id = 'ai-agent' and t.status in ('active', 'pending')
       and ($1::text is null or (t.subject ilike $1 or t.customer_name ilike $1 or t.customer_email ilike $1))
     order by t.updated_at desc limit $2::text::bigint offset $3::text::bigint",
);

const RESOLVED: (&str, &str) = (
    "select count(*)::int from helpdesk_conversations t
     where t.deleted_at is null and t.assignee_id = 'ai-agent' and t.status in ('resolved', 'closed')
       and ($1::text is null or (t.subject ilike $1 or t.customer_name ilike $1 or t.customer_email ilike $1))",
    "select to_jsonb(t) from helpdesk_conversations t
     where t.deleted_at is null and t.assignee_id = 'ai-agent' and t.status in ('resolved', 'closed')
       and ($1::text is null or (t.subject ilike $1 or t.customer_name ilike $1 or t.customer_email ilike $1))
     order by t.updated_at desc limit $2::text::bigint offset $3::text::bigint",
);

/// `((conv.tags as string[]) ?? []).includes('escalated')`.
fn escalated(row: &Value) -> bool {
    match &row["tags"] {
        Value::Array(tags) => tags.iter().any(|tag| tag.as_str() == Some("escalated")),
        Value::String(tags) => tags.contains("escalated"),
        _ => false,
    }
}

async fn page(
    caller: &Caller,
    query: Option<&str>,
    sql: (&str, &str),
    drop_escalated: bool,
    message: &str,
) -> Response {
    // `Number(c.req.query('page') || '1')`.
    let number = |name: &str, fallback: &str| {
        let raw = query_param(query, name).filter(|raw| !raw.is_empty());
        js_number(raw.as_deref().unwrap_or(fallback))
    };
    let page = number("page", "1");
    // `Math.min(NaN, 100)` is NaN.
    let size = {
        let raw = number("pageSize", "25");
        if raw.is_nan() { raw } else { raw.min(100.0) }
    };
    let search = query_param(query, "search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    // Drizzle: `limit` when a number >= 0; `offset` when truthy.
    let limit = (size >= 0.0).then(|| js_number_text(size));
    let offset_value = (page - 1.0) * size;
    let offset = (offset_value != 0.0 && !offset_value.is_nan()).then(|| js_number_text(offset_value));
    let total: i32 = match sqlx::query_scalar(sql.0)
        .bind(search.as_deref())
        .fetch_one(&caller.db)
        .await
    {
        Ok(total) => total,
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let rows: Vec<Value> = match sqlx::query_scalar(sql.1)
        .bind(search.as_deref())
        .bind(limit)
        .bind(offset)
        .fetch_all(&caller.db)
        .await
    {
        Ok(rows) => rows,
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|row| CONV.js(row))
        .filter(|row| !(drop_escalated && escalated(row)))
        .collect();
    let total = f64::from(total);
    Data(json!({
        "conversations": rows,
        "pagination": {
            "page": json_number(page),
            "pageSize": json_number(size),
            "totalCount": json_number(total),
            "totalPages": json_number((total / size).ceil()),
        },
    }))
    .into_response()
}

async fn ai_active(caller: Caller, RawQuery(query): RawQuery) -> Response {
    page(
        &caller,
        query.as_deref(),
        ACTIVE,
        false,
        "Failed to fetch active AI conversations",
    )
    .await
}

async fn ai_resolved(caller: Caller, RawQuery(query): RawQuery) -> Response {
    page(
        &caller,
        query.as_deref(),
        RESOLVED,
        true,
        "Failed to fetch AI-resolved conversations",
    )
    .await
}

async fn pending(caller: Caller) -> Response {
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(t) from helpdesk_conversations t
         where t.status = 'pending' and t.deleted_at is null
         order by t.updated_at desc",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .map(|row| CONV.js(row))
                .filter(escalated)
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to fetch pending escalations"),
    }
}

// ── one conversation ────────────────────────────────────────────────────────

/// The live conversation, or the route's 404 / 500.
async fn existing(caller: &Caller, id: &str, message: &str) -> Result<Value, Response> {
    match CONV.find_live(&caller.db, id).await {
        Ok(Some(row)) => Ok(row),
        Ok(None) => Err(Refusal::not_found("Conversation", id).respond(message)),
        Err(error) => Err(Refusal::Database(error).respond(message)),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const MESSAGE: &str = "Failed to fetch AI conversation";
    let conversation = match existing(&caller, &id, MESSAGE).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let messages: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(m) from helpdesk_conversation_messages m
         where m.conversation_id = $1 and m.deleted_at is null
         order by m.created_at",
    )
    .bind(&id)
    .fetch_all(&caller.db)
    .await;
    let messages = match messages {
        Ok(rows) => rows.into_iter().map(|row| MESSAGES.js(row)).collect(),
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let mut out = match conversation {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    out.insert("messages".to_owned(), Value::Array(messages));
    Data(Value::Object(out)).into_response()
}

/// Insert a conversation message; `metadata` only when given.
async fn insert_message(
    caller: &Caller,
    fields: &[(&str, Value)],
) -> Result<(), crate::table::WriteError> {
    let mut values = Map::new();
    for (prop, value) in fields {
        MESSAGES.set(&mut values, prop, value.clone());
    }
    MESSAGES
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
        .map(|_| ())
}

async fn send_message(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to send message";
    let read = validate(&headers, &body, |issues, fields| {
        let content = issues.text(fields, "content", Presence::Required, Some(1), Some(10_000));
        let role = issues.choice(fields, "role", Presence::Optional, &["user", "assistant"]);
        let metadata = issues.nested(fields, "metadata", Presence::Optional, |_, map| {
            Value::Object(map.clone())
        });
        (
            content.into_option().unwrap_or_default(),
            role.into_option().unwrap_or_else(|| "user".to_owned()),
            metadata.into_option(),
        )
    });
    let (content, role, metadata) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    if let Err(response) = existing(&caller, &id, MESSAGE).await {
        return response;
    }
    let now = now();
    let message_id = generate_id("msg");
    let user = role == "user";
    let author_type = if user { "customer" } else { "agent" };
    let mut fields = vec![
        ("id", json!(message_id)),
        ("conversationId", json!(id)),
        ("authorId", json!(caller.user_id)),
        ("authorName", json!(if user { "User" } else { "WeldAgent" })),
        ("authorType", json!(author_type)),
        ("content", json!(content)),
        ("type", json!("message")),
        ("isPublic", json!(true)),
        ("isInternal", json!(false)),
        ("status", json!("sent")),
        ("isRead", json!(false)),
    ];
    if let Some(metadata) = metadata {
        fields.push(("metadata", metadata));
    }
    fields.push(("createdAt", json!(now)));
    fields.push(("updatedAt", json!(now)));
    if let Err(error) = insert_message(&caller, &fields).await {
        return write_failed(&error, MESSAGE);
    }
    let bumped = sqlx::query(
        "update helpdesk_conversations set last_message = $2, preview = $3,
             last_message_at = $4::timestamp, message_count = message_count + 1,
             updated_at = $4::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(js_substring(&content, 500))
    .bind(js_substring(&content, 200))
    .bind(&now)
    .execute(&caller.db)
    .await;
    if let Err(error) = bumped {
        return Refusal::Database(error).respond(MESSAGE);
    }
    caller.publish(
        &state,
        ev::HELPDESK_CONVERSATION_MESSAGE_CREATED,
        &message_id,
        &json!({
            "id": message_id,
            "conversationId": id,
            "authorId": caller.user_id,
            "authorType": author_type,
            "content": content,
        }),
    );
    Created(json!({
        "id": message_id,
        "conversationId": id,
        "content": content,
        "role": role,
        "createdAt": now,
    }))
    .into_response()
}

async fn transfer(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to transfer to human agent";
    let read = validate(&headers, &body, |issues, fields| {
        let reason = issues.text(fields, "reason", Presence::Required, None, Some(1000));
        let urgency = issues.text(fields, "urgency", Presence::Optional, None, None);
        (
            reason.into_option().unwrap_or_default(),
            urgency.into_option(),
        )
    });
    let (reason, urgency) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let conversation = match existing(&caller, &id, MESSAGE).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let mut tags = match &conversation["tags"] {
        Value::Array(tags) => tags.clone(),
        _ => Vec::new(),
    };
    if !escalated(&json!({ "tags": tags })) {
        tags.push(json!("escalated"));
    }
    let priority = if urgency.as_deref() == Some("urgent") {
        "urgent"
    } else {
        "high"
    };
    let now = now();
    let updated = sqlx::query(
        "update helpdesk_conversations set status = 'pending', priority = $2, tags = $3,
             updated_at = $4::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(priority)
    .bind(Value::Array(tags))
    .bind(&now)
    .execute(&caller.db)
    .await;
    if let Err(error) = updated {
        return Refusal::Database(error).respond(MESSAGE);
    }
    let fields = [
        ("id", json!(generate_id("msg"))),
        ("conversationId", json!(id)),
        ("authorId", json!("system")),
        ("authorName", json!("System")),
        ("authorType", json!("system")),
        (
            "content",
            json!(format!(
                "Conversation transferred to human agent. Reason: {reason}"
            )),
        ),
        ("type", json!("system")),
        ("isPublic", json!(true)),
        ("isInternal", json!(false)),
        ("status", json!("sent")),
        ("isRead", json!(false)),
        ("createdAt", json!(now)),
        ("updatedAt", json!(now)),
    ];
    if let Err(error) = insert_message(&caller, &fields).await {
        return write_failed(&error, MESSAGE);
    }
    caller.publish(
        &state,
        ev::HELPDESK_CONVERSATION_ESCALATED,
        &id,
        &json!({ "id": id, "status": "pending" }),
    );
    Data(json!({ "conversationId": id, "status": "pending", "escalatedAt": now })).into_response()
}

async fn accept(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to accept escalation";
    let read = validate(&headers, &body, |issues, fields| {
        issues
            .text(fields, "agentId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    });
    let agent_id = match read {
        Ok(agent) => agent,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let conversation = match existing(&caller, &id, MESSAGE).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let now = now();
    let updated = sqlx::query(
        "update helpdesk_conversations set assignee_id = $2, status = 'active',
             updated_at = $3::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(&agent_id)
    .bind(&now)
    .execute(&caller.db)
    .await;
    if let Err(error) = updated {
        return Refusal::Database(error).respond(MESSAGE);
    }
    caller.publish(
        &state,
        ev::HELPDESK_CONVERSATION_ASSIGNED,
        &id,
        &json!({ "id": id, "assigneeId": agent_id }),
    );
    assigned(
        &state,
        &caller,
        Assigned {
            assignee_id: Some(agent_id.clone()),
            previous: text(&conversation, "assigneeId").map(str::to_owned),
            kind: EntityKind::Conversation,
            entity_id: id.clone(),
            subject: text(&conversation, "subject").map(str::to_owned),
            reference: text(&conversation, "conversationNumber").map(str::to_owned),
            by: Some(caller.user_id.clone()),
        },
    );
    Data(json!({
        "conversationId": id,
        "assigneeId": agent_id,
        "status": "active",
        "acceptedAt": now,
    }))
    .into_response()
}

async fn convert(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to convert conversation to ticket";
    let opt = Presence::Optional;
    let read = validate(&headers, &body, |issues, fields| {
        let subject = issues.text(fields, "subject", Presence::Required, Some(1), Some(500));
        let description = issues.text(fields, "description", opt, None, None);
        let priority = issues.text(fields, "priority", opt, None, None);
        let category = issues.text(fields, "category", opt, None, None);
        let assignee = issues.text(fields, "assigneeId", opt, None, None);
        (
            subject.into_option().unwrap_or_default(),
            description.into_option(),
            priority.into_option(),
            category.into_option(),
            assignee.into_option(),
        )
    });
    let (subject, description, priority, category, assignee) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let conversation = match existing(&caller, &id, MESSAGE).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let ticket_id = generate_id("tkt");
    let ticket_number = format!("TKT-{}", base36_now());
    let now = now();
    let priority = priority.unwrap_or_else(|| "medium".to_owned());
    // `data.description ?? conversation.lastMessage ?? ''`.
    let description = description
        .or_else(|| text(&conversation, "lastMessage").map(str::to_owned))
        .unwrap_or_default();
    let table = &HELPDESK_TICKETS;
    let mut values = Map::new();
    let mut set = |prop: &str, value: Value| table.set(&mut values, prop, value);
    set("id", json!(ticket_id));
    set("ticketNumber", json!(ticket_number));
    set("subject", json!(subject));
    set("description", json!(description));
    set("status", json!("new"));
    set("priority", json!(priority));
    set("category", json!(category));
    set("channel", json!("chat"));
    set("customerEmail", conversation["customerEmail"].clone());
    set("customerName", conversation["customerName"].clone());
    set("assigneeId", json!(assignee));
    set("tags", json!(["from-ai-conversation"]));
    set("metadata", json!({ "sourceConversationId": id }));
    set("createdAt", json!(now));
    set("updatedAt", json!(now));
    if let Err(error) = table
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    let closed = sqlx::query(
        "update helpdesk_conversations set status = 'closed', updated_at = $2::timestamp where id = $1",
    )
    .bind(&id)
    .bind(&now)
    .execute(&caller.db)
    .await;
    if let Err(error) = closed {
        return Refusal::Database(error).respond(MESSAGE);
    }
    caller.publish(
        &state,
        ev::HELPDESK_TICKET_CREATED,
        &ticket_id,
        &json!({
            "id": ticket_id,
            "ticketNumber": ticket_number,
            "subject": subject,
            "status": "new",
            "priority": priority,
        }),
    );
    Created(json!({
        "ticketId": ticket_id,
        "ticketNumber": ticket_number,
        "subject": subject,
        "status": "new",
        "priority": priority,
        "conversationId": id,
        "createdAt": now,
    }))
    .into_response()
}
