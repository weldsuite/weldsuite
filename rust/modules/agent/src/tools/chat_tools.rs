//! The room tools: `message_agent` and `create_agent_group_chat`
//! (`tools.ts`, `chat.*`).

use serde_json::{Value, json};
use weldsuite_chat_domain::members::{AddMembers, NewChannel, add_channel_members, create_channel};
use weldsuite_chat_domain::policy::merge_agent_room_policy;

use super::{ToolContext, ToolError, ToolSpec};
use crate::rooms::{RoomCtx, RoomInput, dispatch_agent_room_replies, post_agent_text};

pub(super) fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            id: "chat.message_agent",
            name: "message_agent",
            description: "Mention another workspace agent in the current WeldChat room so they can reply. Requires an active channel context.",
            required_permissions: &[],
            parameters: json!({
                "type": "object",
                "properties": {
                    "agentId": { "type": "string", "minLength": 1, "maxLength": 30 },
                    "message": { "type": "string", "minLength": 1, "maxLength": 4000 },
                },
                "required": ["agentId", "message"],
            }),
        },
        ToolSpec {
            id: "chat.create_agent_group",
            name: "create_agent_group_chat",
            description: "Create a private WeldChat room with the current agent, other agents, and the human who invoked this run.",
            required_permissions: &[],
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "minLength": 1, "maxLength": 255 },
                    "agentIds": { "type": "array", "minItems": 1, "maxItems": 20,
                        "items": { "type": "string", "minLength": 1, "maxLength": 30 } },
                    "openingMessage": { "type": "string", "minLength": 1, "maxLength": 4000 },
                    "replyPolicy": { "type": "string", "enum": ["mentions", "always", "none"] },
                },
                "required": ["name", "agentIds"],
            }),
        },
    ]
}

pub(super) async fn execute(ctx: &ToolContext, id: &str, args: &Value) -> Result<Value, ToolError> {
    match id {
        "chat.message_agent" => message_agent(ctx, args).await,
        "chat.create_agent_group" => create_group(ctx, args).await,
        other => Err(ToolError::UnknownTool(other.to_owned())),
    }
}

async fn message_agent(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let Some(channel_id) = &ctx.channel_id else {
        return Ok(
            json!({ "error": "No active channel — this tool only works inside a WeldChat room reply." }),
        );
    };
    let agent_id = args["agentId"].as_str().unwrap_or_default();
    if !agent_id.starts_with("agt_") {
        return Ok(json!({ "error": "agentId must be a workspace agent id (agt_…)" }));
    }
    if agent_id == ctx.agent_id {
        return Ok(json!({ "error": "Cannot message yourself" }));
    }
    let hop = ctx.agent_hop + 1;
    if hop > ctx.max_agent_hops {
        return Ok(json!({ "error": format!("Agent hop limit reached ({})", ctx.max_agent_hops) }));
    }
    let member: Option<String> = sqlx::query_scalar(
        "select id from chat_channel_members where channel_id = $1 and user_id = $2 and member_type = 'agent' limit 1",
    )
    .bind(channel_id)
    .bind(agent_id)
    .fetch_optional(&ctx.db)
    .await?;
    if member.is_none() {
        return Ok(json!({ "error": "Target agent is not a member of this channel" }));
    }
    // Any status: a draft or paused agent still answers when mentioned.
    let target: Option<String> = sqlx::query_scalar(
        "select name from weldagent_agents where id = $1 and deleted_at is null",
    )
    .bind(agent_id)
    .fetch_optional(&ctx.db)
    .await?;
    let Some(name) = target else {
        return Ok(json!({ "error": "Target agent not found" }));
    };
    // The mention token goes into the reply text; the dispatch happens when the
    // reply is posted and scanned for <@agt_…> mentions.
    let message = args["message"].as_str().unwrap_or_default();
    Ok(json!({
        "ok": true,
        "mentionToken": format!("<@{agent_id}>"),
        "agentName": name,
        "hint": format!("Include <@{agent_id}> in your reply text to ping {name}. Message draft: {message}"),
        "draft": message,
    }))
}

async fn create_group(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let requested: Vec<String> = args["agentIds"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let mut agent_ids = vec![ctx.agent_id.clone()];
    for id in &requested {
        if !agent_ids.contains(id) {
            agent_ids.push(id.clone());
        }
    }
    let active: Vec<(String, String)> = sqlx::query_as(
        "select id, name from weldagent_agents where status = 'active' and deleted_at is null",
    )
    .fetch_all(&ctx.db)
    .await?;
    let missing: Vec<&String> = agent_ids
        .iter()
        .filter(|id| !active.iter().any(|(a, _)| a == *id))
        .collect();
    if !missing.is_empty() {
        let list: Vec<&str> = missing.iter().map(|s| s.as_str()).collect();
        return Ok(
            json!({ "error": format!("Unknown or inactive agent(s): {}", list.join(", ")) }),
        );
    }
    let policy = args["replyPolicy"].as_str().unwrap_or("mentions");
    let now = crate::now();
    let created = create_channel(
        &ctx.db,
        &ctx.actor_user_id,
        &NewChannel {
            name: args["name"].as_str().unwrap_or_default().to_owned(),
            kind: "private".to_owned(),
            member_ids: vec![ctx.actor_user_id.clone()],
            metadata: Some(merge_agent_room_policy(None, Some(policy), Some(2))),
            ..NewChannel::default()
        },
        &now,
    )
    .await?;
    let channel_id = created.channel["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let added = match add_channel_members(&ctx.db, &channel_id, &agent_ids, "agent", &now).await? {
        AddMembers::Added { added_user_ids } => added_user_ids.len(),
        AddMembers::Refused(message) => return Ok(json!({ "error": message })),
    };
    let own = active
        .iter()
        .find(|(id, _)| *id == ctx.agent_id)
        .map_or("Agent", |(_, n)| n.as_str());
    let mut opening: Option<String> = None;
    if let Some(text) = args["openingMessage"]
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        let agent = json!({ "id": ctx.agent_id, "name": own });
        let posted = post_agent_text(
            &ctx.db,
            ctx.realtime.clone(),
            &ctx.workspace_id,
            &channel_id,
            &agent,
            &ctx.actor_user_id,
            text,
            0,
        )
        .await?;
        opening = Some(posted.clone());
        let mentioned: Vec<String> = requested
            .iter()
            .filter(|id| **id != ctx.agent_id)
            .cloned()
            .collect();
        if !mentioned.is_empty() {
            let room = RoomCtx {
                db: ctx.db.clone(),
                ai: ctx.ai.clone(),
                env: crate::run::RunEnv {
                    master: ctx.master.clone(),
                    realtime: ctx.realtime.clone(),
                    sandbox: ctx.sandbox,
                },
                org_id: ctx.workspace_id.clone(),
                invoker_user_id: ctx.actor_user_id.clone(),
                actor_permissions: ctx.actor_permissions.clone(),
                events: ctx.events.clone(),
            };
            dispatch_agent_room_replies(
                &room,
                RoomInput {
                    channel_id: channel_id.clone(),
                    message_id: posted,
                    message_content: text.to_owned(),
                    author_id: ctx.agent_id.clone(),
                    author_type: "agent".to_owned(),
                    author_name: own.to_owned(),
                    mentioned_agent_ids: mentioned,
                    hop: 1,
                    max_hops: 2,
                    reply_policy: policy.to_owned(),
                    parent_id: None,
                },
            )
            .await?;
        }
    }
    Ok(json!({
        "ok": true, "channelId": channel_id, "channelName": created.channel["name"],
        "agentMemberCount": added, "openingMessageId": opening,
    }))
}
