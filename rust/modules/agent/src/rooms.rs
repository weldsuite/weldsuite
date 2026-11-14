//! WeldChat multi-agent rooms (`packages/domains/agent/src/agent-mention-dispatch.ts`,
//! `@weldsuite/chat-domain/{post-agent-message,agent-room-policy}`).
//!
//! When a human (or an agent) posts in a channel that has agent members, this
//! selects which agents answer, runs each through the loop, and posts the reply
//! with `authorType: 'agent'`. Replies are background work (the `weldagent.job`
//! `chat-room` job): while an agent runs the room shows "<agent> is working…",
//! the reply quotes the message that asked, and a failed turn answers with what
//! went wrong instead of staying silent.
//!
//! Loop guards: a reply never goes to its own author, `always` does not fan
//! out on messages written by agents (only their @mentions answer), and a chain
//! of agent-to-agent mentions stops after `agentMaxHops`.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ai::Ai;
use weldsuite_chat_domain::policy::parse_agent_room_policy;
use weldsuite_chat_domain::publish::Realtime;
use weldsuite_chat_domain::system_message::extract_chat_mentions;
use weldsuite_chat_domain::text::{build_reply_reference, format_message_preview};
use weldsuite_kit::generate_id;
use weldsuite_ports::{BoxFuture, DynRealtimePublisher, Job, JobContext, JobError};
use weldsuite_subscribers::Tenants;

use crate::agent_loop::{ChatMsg, TurnInput, build_system, run_turn, tools_for, with_sandbox_tools};
use crate::agents::get_agent;
use crate::approvals::approval_label;
use crate::run::{RunEnv, tool_context, turn_sandbox};
use crate::runs::{RunCompletion, complete_agent_run, create_agent_run, mark_run_running};
use crate::tools::EventSink;

/// How many earlier messages an agent reads before the one it answers.
const ROOM_CONTEXT_LIMIT: i64 = 12;

/// `selectAgentsToReply`: who answers a message.
pub fn select_agents_to_reply(
    policy: &str,
    agent_member_ids: &[String],
    mentioned_agent_ids: &[String],
    author_type: &str,
    author_id: &str,
    hop: u32,
    max_hops: u32,
) -> Vec<String> {
    if policy == "none" || hop > max_hops {
        return Vec::new();
    }
    let mentioned_in_room: Vec<String> = mentioned_agent_ids
        .iter()
        .filter(|id| agent_member_ids.contains(id) && id.as_str() != author_id)
        .cloned()
        .collect();
    if policy == "mentions" {
        return mentioned_in_room;
    }
    // always
    if author_type == "agent" || author_type == "system" {
        return mentioned_in_room;
    }
    agent_member_ids
        .iter()
        .filter(|id| id.as_str() != author_id)
        .cloned()
        .collect()
}

/// `roomFailureReply(err)`: the reply a failed turn leaves in the room.
pub fn room_failure_reply(reason: &str) -> String {
    let reason = reason.trim();
    if reason.is_empty() {
        "Sorry, I could not finish this. Try again in a moment.".to_owned()
    } else {
        format!("Sorry, I could not finish this ({reason}). Try again in a moment.")
    }
}

/// `roomReplyTools(enabledTools)`: the agent's own tools, plus the room tools
/// when it has an allow-list.
pub fn room_reply_tools(enabled_tools: &[String], known_tool_ids: &[&str]) -> Vec<String> {
    let has_allow_list = enabled_tools
        .iter()
        .any(|t| known_tool_ids.contains(&t.as_str()));
    let mut out = enabled_tools.to_vec();
    if has_allow_list {
        for id in ["chat.message_agent", "chat.create_agent_group"] {
            if !out.iter().any(|t| t == id) {
                out.push(id.to_owned());
            }
        }
    }
    out
}

/// Who is running room replies.
#[derive(Clone)]
pub struct RoomCtx {
    pub db: PgPool,
    pub ai: Option<Ai>,
    pub env: RunEnv,
    pub org_id: String,
    /// The user whose message started the chain (credits, audit).
    pub invoker_user_id: String,
    /// Permissions of that person; agents never act beyond them. Resolved
    /// from `invoker_user_id` when `None`.
    pub actor_permissions: Option<Vec<String>>,
    pub events: Option<EventSink>,
}

/// What a room reply answers.
#[derive(Debug, Clone)]
pub struct RoomInput {
    pub channel_id: String,
    pub message_id: String,
    pub message_content: String,
    pub author_id: String,
    pub author_type: String,
    pub author_name: String,
    pub mentioned_agent_ids: Vec<String>,
    pub hop: u32,
    pub max_hops: u32,
    pub reply_policy: String,
    pub parent_id: Option<String>,
}

/// `resolveActorPermissions(db, userId)`: empty for unknown or system actors.
pub async fn resolve_actor_permissions(db: &PgPool, user_id: &str) -> Vec<String> {
    if user_id.is_empty() || user_id == "system" {
        return Vec::new();
    }
    let queries = weldsuite_db::TenantPermissionQueries::new(db.clone());
    weldsuite_permissions::resolve_effective_permissions(&queries, user_id)
        .await
        .map(|resolved| resolved.permissions)
        .unwrap_or_default()
}

/// `dispatchAgentMentions(ctx, input)`: entry point after a message is posted:
/// loads the channel policy and the author, then fans out replies.
pub async fn dispatch_agent_mentions(
    ctx: &RoomCtx,
    agent_mention_ids: Vec<String>,
    channel_id: &str,
    message_id: &str,
    message_content: &str,
) -> Result<(), sqlx::Error> {
    let metadata: Option<Option<Value>> =
        sqlx::query_scalar("select metadata from chat_channels where id = $1 limit 1")
            .bind(channel_id)
            .fetch_optional(&ctx.db)
            .await?;
    let Some(metadata) = metadata else {
        return Ok(());
    };
    let trigger: Option<(String, String, String, Option<String>)> = sqlx::query_as(
        "select author_id, author_type, author_name, parent_id from chat_messages where id = $1",
    )
    .bind(message_id)
    .fetch_optional(&ctx.db)
    .await?;
    let Some((author_id, author_type, author_name, parent_id)) = trigger else {
        return Ok(());
    };
    let policy = parse_agent_room_policy(metadata.as_ref());
    dispatch_agent_room_replies(
        ctx,
        RoomInput {
            channel_id: channel_id.to_owned(),
            message_id: message_id.to_owned(),
            message_content: message_content.to_owned(),
            author_id,
            author_type,
            author_name,
            mentioned_agent_ids: agent_mention_ids,
            hop: 0,
            max_hops: u32::try_from(policy.agent_max_hops).unwrap_or(2),
            reply_policy: policy.agent_reply_policy,
            parent_id,
        },
    )
    .await
}

/// `dispatchAgentRoomReplies`: pick the agents and run them at the same time;
/// one slow or failing agent never holds up (or silences) the others.
pub fn dispatch_agent_room_replies(
    ctx: &RoomCtx,
    input: RoomInput,
) -> BoxFuture<'_, Result<(), sqlx::Error>> {
    Box::pin(async move {
        if input.reply_policy == "none" || input.hop > input.max_hops {
            return Ok(());
        }
        let members: Vec<String> = sqlx::query_scalar(
            "select user_id from chat_channel_members where channel_id = $1 and member_type = 'agent'",
        )
        .bind(&input.channel_id)
        .fetch_all(&ctx.db)
        .await?;
        if members.is_empty() {
            return Ok(());
        }
        let to_reply = select_agents_to_reply(
            &input.reply_policy,
            &members,
            &input.mentioned_agent_ids,
            &input.author_type,
            &input.author_id,
            input.hop,
            input.max_hops,
        );
        if to_reply.is_empty() {
            return Ok(());
        }
        // Any status answers a mention (draft and paused agents still chat, like
        // in their own panel); unprompted "always" replies are for active agents
        // only, the way pausing stops routines and event triggers.
        let mut agents: Vec<Value> = Vec::new();
        for id in &to_reply {
            if let Some(agent) = get_agent(&ctx.db, id).await? {
                if input.mentioned_agent_ids.contains(id) || agent["status"] == "active" {
                    agents.push(agent);
                }
            }
        }
        let recent = load_room_context(
            &ctx.db,
            &input.channel_id,
            &input.message_id,
            input.parent_id.as_deref(),
        )
        .await?;
        let reply_to = load_reply_reference(&ctx.db, &input.message_id).await?;
        let brief = describe_room(&ctx.db, &input.channel_id).await?;
        let mut actor_ctx = ctx.clone();
        if actor_ctx.actor_permissions.is_none() {
            actor_ctx.actor_permissions =
                Some(resolve_actor_permissions(&ctx.db, &ctx.invoker_user_id).await);
        }
        let runs = agents.iter().map(|agent| {
            let (actor_ctx, input, recent, reply_to, brief) = (&actor_ctx, &input, &recent, &reply_to, &brief);
            async move {
                if let Err(error) = reply_as_agent(actor_ctx, agent, input, recent, reply_to.as_ref(), brief).await {
                    tracing::error!(%error, agent = %agent["id"], "[weldagent/room] room reply failed");
                }
            }
        });
        futures_util::future::join_all(runs).await;
        Ok(())
    })
}

/// `describeRoom`: what the room is, for the agent's instructions. A record
/// chat names its record, so the agent can look it up with its tools.
pub async fn describe_room(db: &PgPool, channel_id: &str) -> Result<String, sqlx::Error> {
    let room: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select name, type, entity_type, entity_id, entity_display_name from chat_channels where id = $1",
    )
    .bind(channel_id)
    .fetch_optional(db)
    .await?;
    let Some((name, kind, entity_type, entity_id, display)) = room else {
        return Ok("You are in a WeldChat room.".to_owned());
    };
    if kind.as_deref() == Some("entity")
        && let (Some(entity_type), Some(entity_id)) = (entity_type, entity_id)
    {
        let title = display.filter(|d| !d.is_empty()).unwrap_or(name);
        return Ok(format!(
            "You are in the chat of a {entity_type} record: \"{title}\" (id {entity_id}). Questions here are usually about that {entity_type}; look it up with your tools when needed."
        ));
    }
    Ok(format!("You are in the WeldChat channel \"{name}\"."))
}

/// The quote shown above an agent's reply: the message it answers.
async fn load_reply_reference(db: &PgPool, message_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let target: Option<(
        String,
        String,
        String,
        Option<String>,
        String,
        bool,
        Option<Value>,
    )> = sqlx::query_as(
        "select id, author_id, author_name, author_avatar, content, has_attachments, metadata
         from chat_messages where id = $1 and deleted_at is null",
    )
    .bind(message_id)
    .fetch_optional(db)
    .await?;
    Ok(target.map(
        |(id, author_id, name, avatar, content, attachments, metadata)| {
            build_reply_reference(
                &id,
                &author_id,
                &name,
                avatar.as_deref(),
                &content,
                Some(attachments),
                &metadata.unwrap_or(Value::Null),
            )
        },
    ))
}

/// What the agent reads before the message it answers: the thread it was asked
/// in (its opening message included), or else the room's main conversation.
async fn load_room_context(
    db: &PgPool,
    channel_id: &str,
    exclude_message_id: &str,
    thread_id: Option<&str>,
) -> Result<Vec<ChatMsg>, sqlx::Error> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "select id, author_name, author_type, content from chat_messages
         where channel_id = $1 and deleted_at is null
           and (case when $2::text is null then parent_id is null else (id = $2 or parent_id = $2) end)
         order by created_at desc limit $3",
    )
    .bind(channel_id)
    .bind(thread_id)
    .bind(ROOM_CONTEXT_LIMIT)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .rev()
        .filter(|(id, ..)| id != exclude_message_id)
        .map(|(_, name, author_type, content)| ChatMsg {
            role: if author_type == "agent" {
                weldsuite_ai::Role::Assistant
            } else {
                weldsuite_ai::Role::User
            },
            content: format!("[{name}]: {content}"),
        })
        .collect())
}

/// An agent's identity in a room.
struct RoomAgent<'a> {
    id: &'a str,
    name: &'a str,
    icon: Option<&'a str>,
}

/// `postAgentChatMessage`: insert a WeldChat message authored by an agent, move
/// the channel's last-message fields, publish it live and bump the humans'
/// unread counters; people it mentions (and whoever asked) are pinged.
/// Returns the message id.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)] // the steps of one post, in TypeScript's order
async fn post_agent_message(
    db: &PgPool,
    realtime: Option<Arc<dyn DynRealtimePublisher>>,
    org_id: &str,
    channel_id: &str,
    agent: &RoomAgent<'_>,
    invoker_user_id: &str,
    content: &str,
    parent_id: Option<&str>,
    hop: u32,
    reply_to: Option<&Value>,
    notify_user_ids: &[String],
    extra: Value,
) -> Result<String, sqlx::Error> {
    let id = generate_id("msg");
    let now = crate::now();
    let named = extract_chat_mentions(content, &[]);
    let all = extract_chat_mentions(content, notify_user_ids);
    let mut metadata = extra.as_object().cloned().unwrap_or_default();
    if let Some(reply) = reply_to {
        metadata.insert("replyTo".into(), reply.clone());
    }
    metadata.insert("agentHop".into(), json!(hop));
    metadata.insert("invokerUserId".into(), json!(invoker_user_id));
    sqlx::query(
        "insert into chat_messages (id, channel_id, author_id, author_name, author_avatar, author_type, content,
           parent_id, mentions, mentions_everyone, metadata, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, false, $9, $10::timestamp, $10::timestamp)",
    )
    .bind(&id)
    .bind(channel_id)
    .bind(agent.id)
    .bind(agent.name)
    .bind(agent.icon)
    .bind(content)
    .bind(parent_id)
    .bind((!all.is_empty()).then(|| json!(all)))
    .bind(Value::Object(metadata.clone()))
    .bind(&now)
    .execute(db)
    .await?;
    let preview = format_message_preview(content, &HashMap::new());
    sqlx::query(
        "update chat_channels set last_message_at = $2::timestamp, last_message_preview = $3,
           message_count = message_count + 1, updated_at = $2::timestamp where id = $1",
    )
    .bind(channel_id)
    .bind(&now)
    .bind(&preview)
    .execute(db)
    .await?;
    if let Some(parent) = parent_id {
        sqlx::query(
            "update chat_messages set thread_reply_count = thread_reply_count + 1,
               thread_last_reply_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(parent)
        .bind(&now)
        .execute(db)
        .await?;
    }
    let members: Vec<(String, Option<String>)> = sqlx::query_as(
        "select user_id, member_type from chat_channel_members where channel_id = $1",
    )
    .bind(channel_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    let rt = Realtime::new(realtime);
    if rt.is_on() {
        let mut payload = serde_json::Map::new();
        payload.insert("id".into(), json!(id));
        payload.insert("content".into(), json!(content));
        payload.insert("senderId".into(), json!(agent.id));
        payload.insert("senderName".into(), json!(agent.name));
        payload.insert("authorType".into(), json!("agent"));
        if let Some(icon) = agent.icon {
            payload.insert("senderAvatar".into(), json!(icon));
        }
        if let Some(parent) = parent_id {
            payload.insert("threadId".into(), json!(parent));
        }
        if let Some(reply) = reply_to {
            payload.insert("replyTo".into(), reply.clone());
        }
        let extra_meta: serde_json::Map<String, Value> = metadata
            .iter()
            .filter(|(k, _)| k.as_str() == "approvals")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if !extra_meta.is_empty() {
            payload.insert("metadata".into(), Value::Object(extra_meta));
        }
        rt.message(channel_id, payload).await;
        for (user_id, member_type) in &members {
            if member_type.as_deref() != Some("agent") && user_id != agent.id {
                rt.unread_update(org_id, user_id, channel_id, 1).await;
            }
        }
    }
    // Room members only: an agent cannot ping someone about a room they are not in.
    let people: Vec<&str> = members
        .iter()
        .filter(|(_, t)| t.as_deref() != Some("agent"))
        .map(|(u, _)| u.as_str())
        .collect();
    for user_id in all.iter().filter(|m| {
        m.as_str() != "everyone"
            && !m.starts_with("agt_")
            && !m.starts_with("entity:")
            && people.contains(&m.as_str())
    }) {
        let _ = sqlx::query(
            "update chat_channel_members set unread_mention_count = unread_mention_count + 1
             where channel_id = $1 and user_id = $2",
        )
        .bind(channel_id)
        .bind(user_id)
        .execute(db)
        .await;
        if rt.is_on() {
            rt.chat_user(
                org_id,
                user_id,
                "mention",
                json!({ "channelId": channel_id, "messageId": id, "authorName": agent.name, "preview": preview }),
            )
            .await;
        }
        let _ = named.contains(user_id);
    }
    Ok(id)
}

/// Show "<agent> is working…" in the room while a background turn runs. It
/// rides the room's typing event (`agt_*` ids tell clients it is an agent).
async fn typing(
    realtime: Option<&Arc<dyn DynRealtimePublisher>>,
    channel_id: &str,
    agent: &RoomAgent<'_>,
    on: bool,
) {
    let rt = Realtime::new(realtime.cloned());
    if rt.is_on() {
        rt.chat(
            channel_id,
            json!({ "type": "typing", "userId": agent.id, "userName": agent.name, "isTyping": on }),
        )
        .await;
    }
}

/// `pendingApprovalsOf(invocations)`: the approvals a turn parked, for the
/// agent's reply to carry.
fn pending_approvals_of(invocations: &[Value]) -> Vec<Value> {
    invocations
        .iter()
        .filter(|inv| {
            inv["result"]["pendingApproval"] == json!(true)
                && inv["result"]["approvalId"].is_string()
        })
        .map(|inv| {
            json!({
                "id": inv["result"]["approvalId"],
                "label": inv["result"]["label"].as_str().map_or_else(
                    || approval_label(inv["toolName"].as_str().unwrap_or_default(), &inv["args"]),
                    str::to_owned,
                ),
                "status": "pending",
            })
        })
        .collect()
}

/// `approvalsNotice(approvals)`: what the agent posts when it parked actions
/// and wrote nothing else.
fn approvals_notice(approvals: &[Value]) -> String {
    let labels: Vec<&str> = approvals
        .iter()
        .filter_map(|a| a["label"].as_str())
        .collect();
    format!(
        "This needs your approval before I can do it: {}.",
        labels.join("; ")
    )
}

#[allow(clippy::too_many_lines)] // the steps of one room reply, in TypeScript's order
async fn reply_as_agent(
    ctx: &RoomCtx,
    agent: &Value,
    input: &RoomInput,
    recent: &[ChatMsg],
    reply_to: Option<&Value>,
    brief: &str,
) -> Result<(), sqlx::Error> {
    let db = &ctx.db;
    let agent_id = agent["id"].as_str().unwrap_or_default();
    let who = RoomAgent {
        id: agent_id,
        name: agent["name"].as_str().unwrap_or("Agent"),
        icon: agent["icon"].as_str(),
    };
    let run_id = create_agent_run(
        db,
        agent_id,
        Some("queued"),
        "chat",
        Some(&json!({ "channelId": input.channel_id, "messageId": input.message_id, "hop": input.hop })),
    )
    .await?;
    mark_run_running(db, &run_id).await?;
    let extra_system = format!(
        "{brief} Other humans and agents may be present. Address the latest message. \
         You work in the background: the room sees that you are working, and your reply is \
         posted when you finish, so do the work first and then report what you did. \
         To talk to another agent in this room, mention them as <@agt_ID>. \
         Keep replies concise and useful in a group chat.\nTriggering author: {} ({}).",
        input.author_name, input.author_type
    );
    let notify: Vec<String> = if input.author_type == "user" {
        vec![input.author_id.clone()]
    } else {
        Vec::new()
    };
    let post = |content: String, extra: Value| {
        let (who, run_id) = (&who, &run_id);
        async move {
            let mut metadata = extra.as_object().cloned().unwrap_or_default();
            metadata.insert("replyToMessageId".into(), json!(input.message_id));
            metadata.insert("runId".into(), json!(run_id));
            post_agent_message(
                db,
                ctx.env.realtime.clone(),
                &ctx.org_id,
                &input.channel_id,
                who,
                &ctx.invoker_user_id,
                &content,
                input.parent_id.as_deref(),
                input.hop,
                reply_to,
                &notify,
                Value::Object(metadata),
            )
            .await
        }
    };

    let Some(ai) = ctx.ai.as_ref().filter(|ai| ai.enabled()) else {
        typing(ctx.env.realtime.as_ref(), &input.channel_id, &who, false).await;
        post(
            room_failure_reply("AI is currently unavailable"),
            json!({ "failed": true }),
        )
        .await?;
        complete_agent_run(
            db,
            &run_id,
            agent_id,
            RunCompletion {
                error: Some("AI is currently unavailable".into()),
                ..RunCompletion::default()
            },
        )
        .await?;
        return Ok(());
    };

    // The agent's tools for a room reply: its own, plus the room tools.
    let mut room_agent = agent.clone();
    let enabled: Vec<String> = agent["enabledTools"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let ids: Vec<&str> = crate::tools::platform_tools()
        .iter()
        .map(|t| t.id)
        .collect();
    room_agent["enabledTools"] = json!(room_reply_tools(&enabled, &ids));
    room_agent["maxIterations"] = json!(agent["maxIterations"].as_i64().unwrap_or(10).min(8));
    let actor_permissions = ctx.actor_permissions.clone().unwrap_or_default();
    let mut tool_ctx = tool_context(
        &room_agent,
        &ctx.env,
        Some(ai),
        db,
        &ctx.org_id,
        &ctx.invoker_user_id,
        Some(actor_permissions),
        ctx.events.clone(),
    );
    tool_ctx.channel_id = Some(input.channel_id.clone());
    tool_ctx.agent_hop = input.hop;
    tool_ctx.max_agent_hops = input.max_hops;
    let sandbox = turn_sandbox(&ctx.env, ai, &room_agent, &tool_ctx, &input.channel_id).await;
    let tools = with_sandbox_tools(
        &room_agent,
        &tool_ctx,
        sandbox.as_ref(),
        tools_for(&room_agent, &tool_ctx, 2),
    );
    let system = build_system(
        db,
        &room_agent,
        crate::run::has_sandbox_tools(&tools),
        Some(&extra_system),
    )
    .await;
    let mut history: Vec<ChatMsg> = recent.to_vec();
    history.push(ChatMsg::user(format!(
        "[{}]: {}",
        input.author_name, input.message_content
    )));
    typing(ctx.env.realtime.as_ref(), &input.channel_id, &who, true).await;
    let turn = run_turn(TurnInput {
        ai,
        agent: &room_agent,
        ctx: &tool_ctx,
        system,
        history,
        tools,
        skip_approvals: false,
        reference: input.channel_id.clone(),
        sandbox,
    })
    .await;
    typing(ctx.env.realtime.as_ref(), &input.channel_id, &who, false).await;
    let done = match turn {
        Ok(done) => done,
        Err(error) => {
            let message = error.to_string();
            if let Err(post_error) =
                post(room_failure_reply(&message), json!({ "failed": true })).await
            {
                tracing::error!(%post_error, "[weldagent/room] posting the failure reply failed");
            }
            complete_agent_run(
                db,
                &run_id,
                agent_id,
                RunCompletion {
                    error: Some(message),
                    ..RunCompletion::default()
                },
            )
            .await?;
            return Ok(());
        }
    };
    // Actions the agent parked for approval ride on its reply, so the room can
    // show Approve / Reject under it; with nothing else to say, it says that.
    let approvals = pending_approvals_of(&done.invocations);
    let text = {
        let t = done.text.trim();
        if t.is_empty() && !approvals.is_empty() {
            approvals_notice(&approvals)
        } else {
            t.to_owned()
        }
    };
    let extra = if approvals.is_empty() {
        json!({})
    } else {
        json!({ "approvals": approvals })
    };
    let posted = if text.is_empty() {
        None
    } else {
        Some(post(text.clone(), extra).await?)
    };
    let actions: Vec<Value> = done
        .invocations
        .iter()
        .filter(|t| t["state"] == "result" || t["state"] == "error")
        .map(|t| json!({ "tool": t["toolName"], "description": if t["state"] == "error" { "failed" } else { "ok" }, "success": t["state"] == "result" }))
        .collect();
    complete_agent_run(
        db,
        &run_id,
        agent_id,
        RunCompletion {
            success: true,
            result: Some(json!({
                "summary": if text.is_empty() { "(empty reply)".to_owned() } else { text.chars().take(2000).collect::<String>() },
                "actionsPerformed": actions, "toolInvocations": done.invocations,
            })),
            error: None,
            total_iterations: done.steps,
            total_tokens_used: done.tokens,
            tool_call_count: i64::try_from(done.invocations.len()).unwrap_or_default(),
        },
    )
    .await?;
    if let Some(reply_id) = posted {
        dispatch_next_hop(ctx, input, agent, &reply_id, &text).await;
    }
    Ok(())
}

/// Agent to agent chain: agents this reply mentions answer it next, until
/// `agentMaxHops` (and never the agent itself).
async fn dispatch_next_hop(
    ctx: &RoomCtx,
    input: &RoomInput,
    agent: &Value,
    reply_id: &str,
    text: &str,
) {
    let agent_id = agent["id"].as_str().unwrap_or_default();
    let next: Vec<String> = extract_chat_mentions(text, &[])
        .into_iter()
        .filter(|m| m.starts_with("agt_") && m != agent_id)
        .collect();
    if next.is_empty() || input.hop + 1 > input.max_hops {
        return;
    }
    let result = dispatch_agent_room_replies(
        ctx,
        RoomInput {
            channel_id: input.channel_id.clone(),
            message_id: reply_id.to_owned(),
            message_content: text.to_owned(),
            author_id: agent_id.to_owned(),
            author_type: "agent".to_owned(),
            author_name: agent["name"].as_str().unwrap_or("Agent").to_owned(),
            mentioned_agent_ids: next,
            hop: input.hop + 1,
            max_hops: input.max_hops,
            reply_policy: input.reply_policy.clone(),
            parent_id: input.parent_id.clone(),
        },
    )
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "[weldagent/room] agent hop dispatch failed");
    }
}

/// `postAgentChatMessage` for the tools and approval outcomes: a plain
/// message from the agent in a room.
///
/// # Errors
///
/// The tenant database fails.
pub async fn post_agent_text(
    db: &PgPool,
    realtime: Option<Arc<dyn DynRealtimePublisher>>,
    org_id: &str,
    channel_id: &str,
    agent: &Value,
    invoker_user_id: &str,
    content: &str,
    hop: u32,
) -> Result<String, sqlx::Error> {
    let who = RoomAgent {
        id: agent["id"].as_str().unwrap_or_default(),
        name: agent["name"].as_str().unwrap_or("Agent"),
        icon: agent["icon"].as_str(),
    };
    post_agent_message(
        db,
        realtime,
        org_id,
        channel_id,
        &who,
        invoker_user_id,
        content,
        None,
        hop,
        None,
        &[],
        json!({}),
    )
    .await
}

/// The `weldagent.job` job (`runWeldAgentJob`): what chat-api enqueues when a
/// room message should be answered by an agent (`kind: "chat-room"`), and the
/// run and chat-turn kinds.
pub struct WeldAgentJob {
    pub tenants: Arc<dyn Tenants>,
    pub ai: Option<Ai>,
    pub env: RunEnv,
}

/// The job's name (`weldagent.job`).
pub const JOB_NAME: &str = "weldagent.job";

impl Job for WeldAgentJob {
    fn name(&self) -> &'static str {
        JOB_NAME
    }

    fn run<'a>(
        &'a self,
        _ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let kind = payload["kind"].as_str().unwrap_or_default().to_owned();
            let workspace_id = payload["workspaceId"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let tenant = self
                .tenants
                .tenant(&workspace_id)
                .await
                .map_err(|e| JobError::Failed(e.to_string()))?;
            match kind.as_str() {
                "chat-room" => {
                    let ctx = RoomCtx {
                        db: tenant.db.clone(),
                        ai: self.ai.clone(),
                        env: self.env.clone(),
                        org_id: workspace_id,
                        invoker_user_id: payload["invokerUserId"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        actor_permissions: None,
                        events: None,
                    };
                    let mentions: Vec<String> = payload["agentMentionIds"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                    dispatch_agent_mentions(
                        &ctx,
                        mentions,
                        payload["channelId"].as_str().unwrap_or_default(),
                        payload["messageId"].as_str().unwrap_or_default(),
                        payload["messageContent"].as_str().unwrap_or_default(),
                    )
                    .await
                    .map_err(|e| JobError::Failed(e.to_string()))
                }
                "agent-run" => {
                    let params = crate::run::RunParams {
                        db: tenant.db.clone(),
                        workspace_id,
                        actor_user_id: payload["actorUserId"]
                            .as_str()
                            .unwrap_or("system")
                            .to_owned(),
                        agent_id: payload["agentId"].as_str().unwrap_or_default().to_owned(),
                        trigger_type: crate::run::TriggerType::Event,
                        trigger_data: payload.get("triggerData").cloned(),
                        user_message: payload["userMessage"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        extra_system: payload["extraSystem"].as_str().map(str::to_owned),
                        run_id: payload["runId"].as_str().map(str::to_owned),
                        routine_run_id: payload["routineRunId"].as_str().map(str::to_owned),
                        skip_approvals: payload["skipApprovals"] == json!(true),
                        notify: true,
                        actor_permissions: None,
                        events: None,
                        env: self.env.clone(),
                    };
                    crate::run::run_agent(self.ai.as_ref(), params)
                        .await
                        .map(|_| ())
                        .map_err(|e| JobError::Failed(format!("{e:?}")))
                }
                // `chat-turn` jobs are run in the request that accepts the turn
                // (`agent_turn` spawns the reply), so there is nothing to resume.
                _ => Ok(()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| (*i).to_owned()).collect()
    }

    #[test]
    fn mentions_answer_only_when_mentioned_and_never_the_author() {
        let members = s(&["agt_1", "agt_2"]);
        assert_eq!(
            select_agents_to_reply(
                "mentions",
                &members,
                &s(&["agt_2", "agt_9"]),
                "user",
                "u1",
                0,
                2
            ),
            ["agt_2"]
        );
        assert!(
            select_agents_to_reply("mentions", &members, &s(&["agt_1"]), "agent", "agt_1", 0, 2)
                .is_empty()
        );
        assert!(
            select_agents_to_reply("none", &members, &s(&["agt_1"]), "user", "u1", 0, 2).is_empty()
        );
    }

    #[test]
    fn always_does_not_fan_out_on_agent_messages_and_stops_at_the_hop_limit() {
        let members = s(&["agt_1", "agt_2"]);
        assert_eq!(
            select_agents_to_reply("always", &members, &[], "user", "u1", 0, 2),
            members
        );
        assert_eq!(
            select_agents_to_reply("always", &members, &[], "user", "agt_1", 0, 2),
            ["agt_2"]
        );
        assert!(select_agents_to_reply("always", &members, &[], "agent", "agt_1", 0, 2).is_empty());
        assert!(select_agents_to_reply("always", &members, &[], "user", "u1", 3, 2).is_empty());
    }

    #[test]
    fn room_tools_join_an_allow_list_only() {
        let known = ["people.list"];
        assert_eq!(
            room_reply_tools(&s(&["agent.auto_review"]), &known),
            ["agent.auto_review"]
        );
        let with = room_reply_tools(&s(&["people.list"]), &known);
        assert!(with.contains(&"chat.message_agent".to_owned()));
    }

    #[test]
    fn parked_approvals_ride_on_the_reply() {
        let invocations = vec![json!({ "toolName": "create_task", "state": "result",
            "result": { "pendingApproval": true, "approvalId": "apr_1", "label": "Create task \"X\"" } })];
        let approvals = pending_approvals_of(&invocations);
        assert_eq!(approvals[0]["id"], "apr_1");
        assert!(approvals_notice(&approvals).contains("Create task \"X\""));
        assert!(room_failure_reply("").starts_with("Sorry, I could not finish this."));
    }
}
