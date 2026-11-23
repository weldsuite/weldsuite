//! Conversations and messages, `/api/weldagent/conversations/*`, the settings
//! and mention stubs, and the model-list and chat-ask stubs
//! (`apps/workers/agent-api/src/routes/weldagent/index.ts`,
//! `routes/ai-models`, `routes/chat-agent`, `main-chat.ts`).
//!
//! All rows are scoped by the user id: WeldAgent threads are private to the
//! user, so these routes carry no permission beyond the session. The
//! interactive chat stream lives at `/api/ai/chat/stream` (the assistant,
//! phase 3e); this router persists the turns.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func, OnConflict, Query as SqlQuery};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, Order, QueryFilter, QueryOrder, QuerySelect,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_db::orm;
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::weldagent_conversations::{self as conversations, Column};
use weldsuite_schema::tenant::weldagent_messages::{self, Column as Message};

use crate::access::AgentAccess;
use crate::agents::{js, now_tz, row_limit};
use crate::run::{TurnParams, agent_turn, unavailable};
use crate::{AgentState, Caller, failed, validate};

const CONTEXT: &str = "weldagent";

/// `toConversationSummary(conv)` / `serializeConversationSummary(row)`.
pub(crate) fn summary(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "name": row["name"],
        "moduleKey": row["moduleKey"],
        "agentId": row["agentId"],
        "isPinned": row["isPinned"],
        "lastMessageAt": row["lastMessageAt"],
        "messageCount": row["messageCount"],
        "createdAt": row["createdAt"],
    })
}

async fn conversation_row(
    db: &PgPool,
    id: &str,
    user_id: &str,
    live_only: bool,
) -> Result<Option<Value>, DbErr> {
    let mut query = conversations::Entity::find()
        .filter(Column::Id.eq(id))
        .filter(Column::UserId.eq(user_id));
    if live_only {
        query = query.filter(Column::DeletedAt.is_null());
    }
    Ok(query.one(&orm(db)).await?.map(js))
}

/// `getOrCreateMainConversation(db, { userId, agentId, agentName })`: the
/// person's main chat with the agent, created on first use. The unique index
/// makes concurrent first calls converge on one row.
pub(crate) async fn get_or_create_main(
    db: &PgPool,
    user_id: &str,
    agent_id: &str,
    agent_name: &str,
) -> Result<Value, DbErr> {
    let conn = orm(db);
    let find = || async {
        Ok::<_, DbErr>(
            conversations::Entity::find()
                .filter(Column::UserId.eq(user_id))
                .filter(Column::AgentId.eq(agent_id))
                .filter(Column::IsMain.eq(true))
                .filter(Column::DeletedAt.is_null())
                .one(&conn)
                .await?
                .map(js),
        )
    };
    if let Some(existing) = find().await? {
        return Ok(existing);
    }
    let name: String = agent_name.chars().take(255).collect();
    conversations::Entity::insert(conversations::ActiveModel {
        id: Set(generate_id("conv")),
        user_id: Set(user_id.to_owned()),
        agent_id: Set(Some(agent_id.to_owned())),
        name: Set(if name.is_empty() {
            "Agent".to_owned()
        } else {
            name
        }),
        is_main: Set(true),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&conn)
    .await?;
    find()
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("weldagent_conversations".to_owned()))
}

// ── GET /conversations ──────────────────────────────────────────────────────

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    limit: Option<String>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
}

/// `Number.parseInt(text || default, 10)`, at most `max`.
fn limit_of(text: Option<&str>, default: i64, max: i64) -> i64 {
    let text = text.filter(|t| !t.is_empty());
    let parsed = text.map_or(Some(default), |t| {
        let digits: String = t
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-')
            .collect();
        digits.parse::<i64>().ok()
    });
    parsed.unwrap_or(default).min(max)
}

/// `GET /conversations`: the current user's conversations.
pub(crate) async fn list(caller: Caller, Query(query): Query<ListQuery>) -> Response {
    let limit = limit_of(query.limit.as_deref(), 50, 100);
    let agent = query.agent_id.as_deref().filter(|a| !a.is_empty());
    let rows = async {
        let mut find = conversations::Entity::find()
            .filter(Column::UserId.eq(&caller.user_id))
            .filter(Column::DeletedAt.is_null());
        // `agentId=none`: personal assistant chats only (the home sidebar's "Recent").
        find = match agent {
            Some("none") => find.filter(Column::AgentId.is_null()),
            Some(id) => find.filter(Column::AgentId.eq(id)),
            None => find,
        };
        // A bare DESC sorts NULLs first, so a never-used placeholder falls back to
        // its creation time and can't outrank freshly-used chats.
        find.order_by_desc(Column::IsPinned)
            .order_by(
                Expr::from(Func::coalesce([
                    Expr::col(Column::LastMessageAt),
                    Expr::col(Column::CreatedAt),
                ])),
                Order::Desc,
            )
            .limit(row_limit(limit)?)
            .all(&orm(&caller.db))
            .await
    }
    .await;
    match rows {
        Ok(rows) => Data(
            rows.into_iter()
                .map(|r| summary(&js(r)))
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to list conversations"),
    }
}

// ── POST /conversations ─────────────────────────────────────────────────────

/// `POST /conversations`: create a conversation.
pub(crate) async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    struct Input {
        name: Option<String>,
        module_key: Option<String>,
        agent_id: Option<String>,
    }
    let data = match validate(&headers, &body, |issues, fields| Input {
        name: issues
            .text(fields, "name", Presence::Optional, None, None)
            .into_option(),
        module_key: issues
            .text(fields, "moduleKey", Presence::Optional, None, None)
            .into_option(),
        agent_id: issues
            .text(fields, "agentId", Presence::Optional, Some(1), Some(30))
            .into_option(),
    }) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let result = async {
        if let Some(agent_id) = data.agent_id.as_deref().filter(|a| !a.is_empty()) {
            let agent = crate::agents::get_agent(&caller.db, agent_id).await?;
            let allowed = match &agent {
                Some(agent) => {
                    crate::access::can_access_agent(
                        &caller.db,
                        &AgentAccess {
                            id: agent_id,
                            owner_id: agent["ownerId"].as_str(),
                            visibility: agent["visibility"].as_str().unwrap_or("workspace"),
                        },
                        &caller.viewer(),
                    )
                    .await?
                }
                None => false,
            };
            if !allowed {
                return Ok::<_, DbErr>(Err(agent_id.to_owned()));
            }
        }
        let id = generate_id("conv");
        let name = data
            .name
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "New Conversation".to_owned());
        // Seed lastMessageAt so a brand-new conversation sorts by recency
        // from the moment it's created.
        conversations::Entity::insert(conversations::ActiveModel {
            id: Set(id.clone()),
            user_id: Set(caller.user_id.clone()),
            name: Set(name),
            module_key: Set(data.module_key.filter(|m| !m.is_empty())),
            agent_id: Set(data.agent_id.filter(|a| !a.is_empty())),
            is_pinned: Set(false),
            message_count: Set(0),
            last_message_at: Set(Some(now_tz())),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        Ok(Ok(conversation_row(
            &caller.db,
            &id,
            &caller.user_id,
            false,
        )
        .await?))
    }
    .await;
    match result {
        Ok(Ok(Some(row))) => Created(summary(&row)).into_response(),
        Ok(Ok(None)) => ApiError::internal()
            .with_message("Failed to create conversation")
            .into_response(),
        Ok(Err(agent_id)) => ApiError::not_found("Agent", Some(&agent_id)).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to create conversation"),
    }
}

// ── GET /conversations/:id ──────────────────────────────────────────────────

/// `GET /conversations/:conversationId`: one of the current user's
/// conversations (notification links).
pub(crate) async fn detail(caller: Caller, Path(conversation_id): Path<String>) -> Response {
    match conversation_row(&caller.db, &conversation_id, &caller.user_id, true).await {
        Ok(Some(row)) => Data(summary(&row)).into_response(),
        Ok(None) => ApiError::not_found("Conversation", Some(&conversation_id)).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to load conversation"),
    }
}

// ── GET/POST /conversations/:id/messages ────────────────────────────────────

#[derive(Deserialize)]
pub(crate) struct MessagesQuery {
    limit: Option<String>,
    offset: Option<String>,
    before: Option<String>,
}

/// `GET /conversations/:conversationId/messages`: messages in a thread.
pub(crate) async fn messages(
    caller: Caller,
    Path(conversation_id): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> Response {
    let limit = limit_of(query.limit.as_deref(), 100, 200);
    let result = async {
        if conversation_row(&caller.db, &conversation_id, &caller.user_id, false)
            .await?
            .is_none()
        {
            return Ok::<_, DbErr>(None);
        }
        let conn = orm(&caller.db);
        let live = weldagent_messages::Entity::find()
            .filter(Message::ConversationId.eq(&conversation_id))
            .filter(Message::DeletedAt.is_null());
        let rows =
            |found: Vec<weldagent_messages::Model>| found.into_iter().map(js).collect::<Vec<_>>();
        // `before=<messageId>`: the page just older than that message (scrolling
        // back through a long continuous chat), in chronological order.
        if let Some(before) = query.before.as_deref().filter(|b| !b.is_empty()) {
            let anchor: Option<String> = weldagent_messages::Entity::find()
                .select_only()
                .column(Message::Id)
                .filter(Message::Id.eq(before))
                .filter(Message::ConversationId.eq(&conversation_id))
                .into_tuple()
                .one(&conn)
                .await?;
            let Some(anchor) = anchor else {
                return Ok(Some(Vec::new()));
            };
            let mut older = rows(
                live.filter(before_message(anchor, false))
                    .order_by_desc(Message::CreatedAt)
                    .order_by_desc(Message::Id)
                    .limit(row_limit(limit)?)
                    .all(&conn)
                    .await?,
            );
            older.reverse();
            return Ok(Some(older));
        }
        // With an explicit offset: legacy oldest-first paging. Without one: the
        // latest `limit` messages, still in chronological order.
        if let Some(offset) = query.offset.as_deref() {
            let offset = limit_of(Some(offset), 0, i64::MAX).max(0);
            let page = rows(
                live.order_by_asc(Message::CreatedAt)
                    .order_by_asc(Message::Id)
                    .limit(row_limit(limit)?)
                    .offset(row_limit(offset)?)
                    .all(&conn)
                    .await?,
            );
            return Ok(Some(page));
        }
        let mut latest = rows(
            live.order_by_desc(Message::CreatedAt)
                .order_by_desc(Message::Id)
                .limit(row_limit(limit)?)
                .all(&conn)
                .await?,
        );
        latest.reverse();
        Ok(Some(latest))
    }
    .await;
    match result {
        Ok(Some(rows)) => Data(rows).into_response(),
        Ok(None) => ApiError::not_found("Conversation", Some(&conversation_id)).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to get messages"),
    }
}

/// `(m.created_at, m.id) < (select a.created_at, a.id from weldagent_messages a
/// where a.id = $anchor)`, or `<=` with `through`: the messages before (or up
/// to) one of them, in the `created_at, id` order.
pub(crate) fn before_message(anchor: String, through: bool) -> sea_orm::sea_query::Expr {
    let at = SqlQuery::select()
        .columns([Message::CreatedAt, Message::Id])
        .from(weldagent_messages::Entity)
        .and_where(sea_orm::ExprTrait::eq(Expr::col(Message::Id), anchor))
        .to_owned();
    let row = Expr::tuple([
        Expr::col((weldagent_messages::Entity, Message::CreatedAt)),
        Expr::col((weldagent_messages::Entity, Message::Id)),
    ]);
    if through {
        sea_orm::ExprTrait::lte(row, Expr::from(at))
    } else {
        sea_orm::ExprTrait::lt(row, Expr::from(at))
    }
}

/// `POST /conversations/:conversationId/messages`: append a message.
pub(crate) async fn append_message(
    caller: Caller,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    struct Input {
        role: String,
        content: String,
        tool_invocations: Option<Value>,
        form_state: Option<Value>,
    }
    let data = match validate(&headers, &body, |issues, fields| Input {
        role: issues
            .choice(
                fields,
                "role",
                Presence::Required,
                &["user", "assistant", "system"],
            )
            .into_option()
            .unwrap_or_default(),
        content: issues
            .text(fields, "content", Presence::Required, None, None)
            .into_option()
            .unwrap_or_default(),
        tool_invocations: match fields.get("toolInvocations") {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(Value::Array(items.clone())),
            Some(_) => {
                issues.custom("toolInvocations", "Expected array, received other");
                None
            }
        },
        form_state: fields.get("formState").filter(|v| !v.is_null()).cloned(),
    }) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let result = async {
        if conversation_row(&caller.db, &conversation_id, &caller.user_id, false)
            .await?
            .is_none()
        {
            return Ok::<_, DbErr>(None);
        }
        let conn = orm(&caller.db);
        let message_id = generate_id("msg");
        weldagent_messages::Entity::insert(weldagent_messages::ActiveModel {
            id: Set(message_id.clone()),
            conversation_id: Set(conversation_id.clone()),
            role: Set(data.role),
            content: Set(data.content),
            tool_invocations: Set(data.tool_invocations),
            form_state: Set(data.form_state),
            ..Default::default()
        })
        .exec_without_returning(&conn)
        .await?;
        touch_conversation(&conn, &conversation_id).await?;
        let saved = weldagent_messages::Entity::find_by_id(message_id)
            .one(&conn)
            .await?;
        Ok(saved.map(js))
    }
    .await;
    match result {
        Ok(Some(saved)) => Created(saved).into_response(),
        Ok(None) => ApiError::not_found("Conversation", Some(&conversation_id)).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to save message"),
    }
}

/// A message went into the conversation: `last_message_at`, `message_count`
/// and `updated_at` move.
pub(crate) async fn touch_conversation(
    conn: &impl sea_orm::ConnectionTrait,
    conversation_id: &str,
) -> Result<(), DbErr> {
    let stamp = now_tz();
    conversations::Entity::update_many()
        .col_expr(Column::LastMessageAt, Expr::value(stamp))
        .col_expr(
            Column::MessageCount,
            sea_orm::ExprTrait::add(Expr::col(Column::MessageCount), 1),
        )
        .col_expr(Column::UpdatedAt, Expr::value(stamp))
        .filter(Column::Id.eq(conversation_id))
        .exec(conn)
        .await?;
    Ok(())
}

// ── POST /conversations/:id/complete-turn ───────────────────────────────────

/// `POST /conversations/:conversationId/complete-turn`: a server-owned chat
/// turn, through the loop's seam ([`crate::run::agent_turn`]).
pub(crate) async fn complete_turn(
    State(state): State<AgentState>,
    caller: Caller,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    struct Input {
        content: String,
        agent_id: Option<String>,
        wait: bool,
        timezone: Option<String>,
    }
    let data = match validate(&headers, &body, |issues, fields| Input {
        content: issues
            .text(fields, "content", Presence::Required, Some(1), Some(20000))
            .into_option()
            .unwrap_or_default(),
        agent_id: issues
            .text(fields, "agentId", Presence::Optional, Some(1), Some(30))
            .into_option(),
        wait: issues
            .boolean(fields, "wait", Presence::Optional)
            .into_option()
            .unwrap_or(false),
        timezone: issues
            .text(fields, "timezone", Presence::Optional, Some(1), Some(64))
            .into_option(),
    }) {
        Ok(data) => data,
        Err(response) => return response,
    };
    match conversation_row(&caller.db, &conversation_id, &caller.user_id, true).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return ApiError::not_found("Conversation", Some(&conversation_id)).into_response();
        }
        Err(error) => return failed(&error, CONTEXT, "Failed to complete turn"),
    }
    let params = TurnParams {
        db: caller.db.clone(),
        workspace_id: caller.workspace_id.clone(),
        user_id: caller.user_id.clone(),
        conversation_id,
        content: data.content,
        agent_id: data.agent_id,
        actor_permissions: caller.permissions.resolved().permissions.clone(),
        timezone: data.timezone,
        wait: data.wait,
        events: Some(crate::tools::EventSink {
            publisher: state.events.clone(),
            context: caller.events.clone(),
        }),
        env: state.run_env(),
    };
    match agent_turn(caller.ai(&state).as_ref(), params).await {
        Ok(result) => Data(result).into_response(),
        Err(error) => error.into_response_for("Failed to complete turn"),
    }
}

// ── PATCH /conversations/:id ────────────────────────────────────────────────

/// `PATCH /conversations/:conversationId`: rename / pin.
pub(crate) async fn update(
    caller: Caller,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    struct Input {
        name: Option<String>,
        is_pinned: Option<bool>,
    }
    let data = match validate(&headers, &body, |issues, fields| Input {
        name: issues
            .text(fields, "name", Presence::Optional, None, None)
            .into_option(),
        is_pinned: issues
            .boolean(fields, "isPinned", Presence::Optional)
            .into_option(),
    }) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let result = async {
        // `coalesce($new, column)`: only what the body sent changes.
        let mut update =
            conversations::Entity::update_many().col_expr(Column::UpdatedAt, Expr::value(now_tz()));
        if let Some(name) = &data.name {
            update = update.col_expr(Column::Name, Expr::value(name));
        }
        if let Some(pinned) = data.is_pinned {
            update = update.col_expr(Column::IsPinned, Expr::value(pinned));
        }
        update
            .filter(Column::Id.eq(&conversation_id))
            .filter(Column::UserId.eq(&caller.user_id))
            .exec(&orm(&caller.db))
            .await?;
        conversation_row(&caller.db, &conversation_id, &caller.user_id, false).await
    }
    .await;
    match result {
        Ok(Some(row)) => Data(summary(&row)).into_response(),
        Ok(None) => ApiError::not_found("Conversation", Some(&conversation_id)).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to update conversation"),
    }
}

// ── POST /conversations/:id/auto-title ──────────────────────────────────────

/// `POST /conversations/:conversationId/auto-title`: a short title from the
/// first user message, only while the conversation still has its placeholder
/// name, so a user-chosen name is never clobbered.
pub(crate) async fn auto_title(
    caller: Caller,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let first = match validate(&headers, &body, |issues, fields| {
        let _ = issues.text(
            fields,
            "firstAssistantMessage",
            Presence::Optional,
            None,
            None,
        );
        issues
            .text(
                fields,
                "firstUserMessage",
                Presence::Required,
                Some(1),
                None,
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(first) => first,
        Err(response) => return response,
    };
    let result = async {
        let Some(existing) =
            conversation_row(&caller.db, &conversation_id, &caller.user_id, false).await?
        else {
            return Ok::<_, DbErr>(None);
        };
        let name = existing["name"].as_str().unwrap_or_default();
        if !(name.is_empty() || name == "New Chat" || name == "New Conversation") {
            return Ok(Some(
                json!({ "id": existing["id"], "name": name, "generated": false }),
            ));
        }
        let collapsed = first.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut title: String = collapsed.trim().chars().take(60).collect();
        if title.is_empty() {
            "New Chat".clone_into(&mut title);
        }
        conversations::Entity::update_many()
            .col_expr(Column::Name, Expr::value(&title))
            .col_expr(Column::UpdatedAt, Expr::value(now_tz()))
            .filter(Column::Id.eq(&conversation_id))
            .filter(Column::UserId.eq(&caller.user_id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(Some(
            json!({ "id": conversation_id, "name": title, "generated": true }),
        ))
    }
    .await;
    match result {
        Ok(Some(out)) => Data(out).into_response(),
        Ok(None) => ApiError::not_found("Conversation", Some(&conversation_id)).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to auto-title conversation"),
    }
}

// ── DELETE /conversations/:id ───────────────────────────────────────────────

/// `DELETE /conversations/:conversationId`: soft delete.
pub(crate) async fn remove(caller: Caller, Path(conversation_id): Path<String>) -> Response {
    let result = async {
        if conversation_row(&caller.db, &conversation_id, &caller.user_id, false)
            .await?
            .is_none()
        {
            return Ok::<_, DbErr>(false);
        }
        let now = now_tz();
        conversations::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(now))
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(Column::Id.eq(&conversation_id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(true)
    }
    .await;
    match result {
        Ok(true) => NoContent.into_response(),
        Ok(false) => ApiError::not_found("Conversation", Some(&conversation_id)).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to delete conversation"),
    }
}

// ── Settings and mentions: safe defaults ────────────────────────────────────

/// `DEFAULT_SETTINGS`.
fn default_settings() -> Map<String, Value> {
    let Value::Object(map) = json!({
        "preferredModel": "openai/gpt-4o",
        "fallbackModel": "anthropic/claude-sonnet-4-20250514",
        "temperature": 0.7,
        "maxTokens": 4096,
        "showToolCalls": true,
        "autoSendSuggestions": false,
        "saveConversationHistory": true,
        "customInstructions": "",
        "appPermissions": {
            "crm": true, "accounting": true, "wms": true, "mail": true, "helpdesk": true,
            "parcel": true, "projects": true, "tasks": true, "host": true,
        },
    }) else {
        return Map::new();
    };
    map
}

/// `GET /settings`: per-user WeldAgent settings (defaults).
pub(crate) async fn settings(caller: Caller) -> Response {
    let mut out = Map::new();
    out.insert("id".into(), json!(""));
    out.insert("userId".into(), json!(caller.user_id));
    out.extend(default_settings());
    Data(Value::Object(out)).into_response()
}

/// `PUT /settings`: echo merged settings (not persisted).
pub(crate) async fn put_settings(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        let mut set = Map::new();
        if let Some(v) = issues
            .text(fields, "preferredModel", Presence::Optional, None, None)
            .into_option()
        {
            set.insert("preferredModel".into(), json!(v));
        }
        match issues.text(fields, "fallbackModel", Presence::Nullish, None, None) {
            weldsuite_kit::validation::Field::Set(v) => {
                set.insert("fallbackModel".into(), json!(v));
            }
            weldsuite_kit::validation::Field::Null => {
                set.insert("fallbackModel".into(), Value::Null);
            }
            weldsuite_kit::validation::Field::Absent => {}
        }
        let num = |issues: &mut weldsuite_kit::validation::Issues,
                   key: &str,
                   int: bool,
                   min: f64,
                   max: f64| {
            issues
                .number(
                    fields,
                    key,
                    Presence::Optional,
                    Number {
                        int,
                        min: Some(min),
                        max: Some(max),
                        ..Number::default()
                    },
                )
                .into_option()
        };
        if let Some(v) = num(issues, "temperature", false, 0.0, 2.0) {
            set.insert("temperature".into(), json!(v));
        }
        if let Some(v) = num(issues, "maxTokens", false, 1.0, 32768.0) {
            set.insert("maxTokens".into(), json!(v));
        }
        for key in [
            "showToolCalls",
            "autoSendSuggestions",
            "saveConversationHistory",
        ] {
            if let Some(v) = issues
                .boolean(fields, key, Presence::Optional)
                .into_option()
            {
                set.insert(key.into(), json!(v));
            }
        }
        if let Some(v) = issues
            .text(
                fields,
                "customInstructions",
                Presence::Optional,
                None,
                Some(2000),
            )
            .into_option()
        {
            set.insert("customInstructions".into(), json!(v));
        }
        if let Some(Value::Object(perms)) = fields.get("appPermissions") {
            set.insert("appPermissions".into(), Value::Object(perms.clone()));
        }
        set
    }) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(""));
    out.insert("userId".into(), json!(caller.user_id));
    out.extend(default_settings());
    out.extend(data);
    Data(Value::Object(out)).into_response()
}

/// `GET /mentions/search`: no results (mention search is disabled).
pub(crate) async fn mentions_search() -> Response {
    Data(json!([])).into_response()
}

// ── ai-models, chat-agent ───────────────────────────────────────────────────

/// `GET /api/ai-models/models`: AI is currently unavailable (the worker's
/// stub; the model list of the EU edition comes with the assistant).
pub(crate) async fn models_unavailable() -> Response {
    unavailable()
}

/// `POST /api/chat-agent/ask`: validated, then AI is currently unavailable.
pub(crate) async fn chat_ask(headers: HeaderMap, body: Bytes) -> Response {
    match validate(&headers, &body, |issues, fields| {
        let _ = issues.text(fields, "question", Presence::Required, Some(1), None);
        let _ = issues.text(fields, "channelId", Presence::Required, Some(1), None);
    }) {
        Ok(()) => unavailable(),
        Err(response) => response,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_read_like_parse_int() {
        assert_eq!(limit_of(None, 50, 100), 50);
        assert_eq!(limit_of(Some("20"), 50, 100), 20);
        assert_eq!(limit_of(Some("500"), 50, 100), 100);
        assert_eq!(limit_of(Some("abc"), 50, 100), 50);
        assert_eq!(limit_of(Some("30x"), 50, 100), 30);
    }

    #[test]
    fn the_summary_keeps_the_eight_fields() {
        let row = json!({ "id": "conv_1", "name": "n", "moduleKey": null, "agentId": "agt_1", "isPinned": false,
            "lastMessageAt": null, "messageCount": 0, "createdAt": "2026-11-13T10:00:00.000Z", "userId": "u1" });
        let s = summary(&row);
        assert_eq!(s.as_object().unwrap().len(), 8);
        assert!(s.get("userId").is_none());
    }

    #[test]
    fn default_settings_match_the_worker() {
        let s = default_settings();
        assert_eq!(s["maxTokens"], 4096);
        assert_eq!(s["appPermissions"]["crm"], true);
    }
}
