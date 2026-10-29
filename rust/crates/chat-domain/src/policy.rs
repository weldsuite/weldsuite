//! The multi-agent room policy on `chat_channels.metadata`
//! (`@weldsuite/chat-domain/agent-room-policy`).

use serde_json::{Map, Value};

pub const DEFAULT_AGENT_REPLY_POLICY: &str = "mentions";
pub const DEFAULT_AGENT_MAX_HOPS: i64 = 2;
pub const ABSOLUTE_AGENT_MAX_HOPS: i64 = 5;

/// `AgentRoomPolicy`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRoomPolicy {
    pub agent_reply_policy: String,
    pub agent_max_hops: i64,
}

/// `parseAgentRoomPolicy(metadata)`.
pub fn parse_agent_room_policy(metadata: Option<&Value>) -> AgentRoomPolicy {
    let fields = metadata.and_then(Value::as_object);
    let raw_policy = fields.and_then(|m| m.get("agentReplyPolicy")).and_then(Value::as_str);
    let agent_reply_policy = match raw_policy {
        Some(policy @ ("always" | "none" | "mentions")) => policy.to_owned(),
        _ => DEFAULT_AGENT_REPLY_POLICY.to_owned(),
    };
    let mut agent_max_hops = DEFAULT_AGENT_MAX_HOPS;
    if let Some(hops) = fields
        .and_then(|m| m.get("agentMaxHops"))
        .and_then(Value::as_f64)
        .filter(|h| h.is_finite())
    {
        #[allow(clippy::cast_possible_truncation)]
        let floored = hops.floor() as i64;
        agent_max_hops = floored.clamp(1, ABSOLUTE_AGENT_MAX_HOPS);
    }
    AgentRoomPolicy {
        agent_reply_policy,
        agent_max_hops,
    }
}

/// `mergeAgentRoomPolicy(existing, patch)`: `existing` with the policy's two
/// keys set (kept in place when present, else appended).
pub fn merge_agent_room_policy(
    existing: Option<&Value>,
    reply_policy: Option<&str>,
    max_hops: Option<i64>,
) -> Value {
    let current = parse_agent_room_policy(existing);
    let mut next: Map<String, Value> = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    next.insert(
        "agentReplyPolicy".to_owned(),
        Value::String(reply_policy.map_or(current.agent_reply_policy, str::to_owned)),
    );
    next.insert(
        "agentMaxHops".to_owned(),
        Value::from(max_hops.unwrap_or(current.agent_max_hops)),
    );
    Value::Object(next)
}
