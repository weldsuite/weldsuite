//! The realtime backplane on Valkey: what [`crate::ValkeyRealtime`] writes
//! and the WebSocket gateway (`weldsuite-realtime`) reads, so every pod of
//! `weldsuite serve` delivers what any process publishes.
//!
//! What a Durable Object did by being the only copy of a hub or room, Valkey
//! does by being the one place every pod talks to:
//!
//! - **Workspace hubs** (`workspace:<hub key>`): a Lua script stamps each
//!   event with the next id of the hub's counter and its time, appends it to
//!   the hub's replay log (a sorted set, six hours, at most
//!   [`REPLAY_MAX_EVENTS`]) and publishes it, all in one step, so every pod
//!   sees the same `eventId` and a client reconnecting to another pod replays
//!   from its cursor. The counter starts from the clock (`ms × 1000`), so a
//!   wiped Valkey never hands out an id below one a client already holds.
//!   `_access.userIds` leaves the event's `data` at publish time and travels
//!   beside it, as the `WorkspaceHub` strips it before storing.
//! - **Chat rooms** (`chat:<channel id>`): a `message` gets the room's next
//!   `seq`, as the `ChatRoom` numbered them for gap detection.
//! - **Other rooms** (`support:`, `conversation:`): the body as published.
//!   What a client says in a room (typing, presence) goes on the same
//!   channel as a peer message, `P<connection id>\n<json>`, so each pod can
//!   leave out the sender.
//! - **Live presence**: each pod writes, per member, what its own connections
//!   add up to; a script folds the pods that are alive into one status,
//!   remembers what was last announced, and publishes a change on the hub's
//!   channel. The offline grace period and the members of a pod that died
//!   are settled there too, so two pods never announce the same change.
//! - **Room members** (who entered a room's presence): a hash per room.
//!
//! The scripts read the clock and the live pods from Valkey itself, so the
//! pods' clocks don't matter. They take keys from different hash slots (the
//! pod registry), so the backplane needs a standalone Valkey (or a primary
//! with replicas), not a Valkey cluster.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use redis::aio::ConnectionManager;
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::sync::{mpsc, oneshot};
use weldsuite_ports::{LivePresence, PortError, RealtimeMessage};

/// How long a workspace's replay log keeps an event (the `WorkspaceHub`'s
/// `EVENT_LOG_TTL_MS`).
pub const REPLAY_TTL: Duration = Duration::from_hours(6);
/// The most events a hub's replay log keeps; older ones fall out first.
pub const REPLAY_MAX_EVENTS: usize = 10_000;
/// How long an idle hub or room keeps its counter: longer than its log, so a
/// counter never restarts under a cursor the log could still answer.
const COUNTER_TTL: Duration = Duration::from_hours(30 * 24);
/// The `WorkspaceHub`'s `OFFLINE_GRACE_MS`.
pub const OFFLINE_GRACE: Duration = Duration::from_secs(5);
/// How long presence and room-member state outlives the last write to it.
const STATE_TTL: Duration = Duration::from_hours(24);
/// A pod that has not checked in for this long is gone.
pub const POD_TTL: Duration = Duration::from_secs(30);
/// How often a pod checks in.
pub const POD_HEARTBEAT: Duration = Duration::from_secs(10);

/// The Valkey names of everything above, under one prefix
/// (`VALKEY_REALTIME_PREFIX`).
#[derive(Debug, Clone)]
pub struct RealtimeKeys {
    prefix: String,
}

impl RealtimeKeys {
    pub fn new(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
        }
    }

    /// The pub/sub channel of a hub or room (`workspace:org_1`).
    pub fn channel(&self, channel: &str) -> String {
        format!("{}{channel}", self.prefix)
    }

    /// A Valkey channel name back to the hub or room it carries.
    pub fn strip<'a>(&self, valkey_channel: &'a str) -> Option<&'a str> {
        valkey_channel.strip_prefix(self.prefix.as_str())
    }

    fn log(&self, channel: &str) -> String {
        format!("{}log:{channel}", self.prefix)
    }

    fn seq(&self, channel: &str) -> String {
        format!("{}seq:{channel}", self.prefix)
    }

    fn presence(&self, hub: &str) -> String {
        format!("{}presence:{hub}", self.prefix)
    }

    fn members(&self, channel: &str) -> String {
        format!("{}members:{channel}", self.prefix)
    }

    fn pods(&self) -> String {
        format!("{}pods", self.prefix)
    }
}

/// Stamp, log and publish one workspace event.
const PUBLISH_EVENT: &str = r#"
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('SET', KEYS[1], string.format('%d', now * 1000), 'NX')
local seq = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
local id = string.format('%016d', seq)
local access = ''
if ARGV[1] ~= '' then access = ',"access":' .. ARGV[1] end
local envelope = '{"eventId":"' .. id .. '","ts":' .. string.format('%d', now) .. access .. ',"body":' .. ARGV[2] .. '}'
redis.call('ZADD', KEYS[2], string.format('%d', seq), envelope)
local cutoff = now - tonumber(ARGV[3])
for _ = 1, 64 do
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0)
  local ts = oldest[1] and tonumber(string.match(oldest[1], '"ts":(%d+)'))
  if not ts or ts > cutoff then break end
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, 0)
end
redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -(tonumber(ARGV[4]) + 1))
redis.call('PEXPIRE', KEYS[2], ARGV[3])
redis.call('PUBLISH', KEYS[3], envelope)
return id
"#;

/// Number and publish one chat `message`: the body gets `"seq":<n>` last, as
/// `payload.seq = …` added it.
const PUBLISH_CHAT_MESSAGE: &str = r#"
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('SET', KEYS[1], string.format('%d', now * 1000), 'NX')
local seq = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
local body = ARGV[1]
local tail = '"seq":' .. string.format('%d', seq) .. '}'
local payload
if body == '{}' then payload = '{' .. tail else payload = string.sub(body, 1, -2) .. ',' .. tail end
redis.call('PUBLISH', KEYS[2], payload)
return seq
"#;

/// A pod checks in: alive until now + `ARGV[2]` ms. Pods past theirs leave.
const POD_CHECK_IN: &str = r"
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZADD', KEYS[1], string.format('%d', now + tonumber(ARGV[2])), ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', string.format('%d', now))
return 1
";

/// Shared by the presence scripts. `KEYS`: the hub's presence hash, its
/// channel, the pod registry. `ARGV[1]`: the grace period, `ARGV[2]`: the
/// state TTL (ms). Hash fields: `c:<pod>|<user>` what a pod's connections
/// add up to, `l:<user>` what was last announced, `g:<user>` when the grace
/// period of a member with no connection left ends.
macro_rules! presence_prelude {
    () => {
        r#"
local P, CH, PODS = KEYS[1], KEYS[2], KEYS[3]
local grace, ttl = tonumber(ARGV[1]), tonumber(ARGV[2])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local alive = {}
for _, pod in ipairs(redis.call('ZRANGEBYSCORE', PODS, string.format('%d', now), '+inf')) do alive[pod] = true end
local RANK = { away = 1, online = 2, busy = 3 }
local function esc(s)
  return (string.gsub(s, '[%c"\\]', function(c) return string.format('\\u%04x', string.byte(c)) end))
end
local function announce(user, live)
  local value = 'null'
  if live then value = '"' .. live .. '"' end
  redis.call('PUBLISH', CH, '{"presence":{"userId":"' .. esc(user) .. '","live":' .. value .. '}}')
end
local function aggregate(user)
  local best, rank = false, 0
  for pod in pairs(alive) do
    local v = redis.call('HGET', P, 'c:' .. pod .. '|' .. user)
    if v and RANK[v] and RANK[v] > rank then best, rank = v, RANK[v] end
  end
  return best
end
local function settle(user)
  local live = aggregate(user)
  local last = redis.call('HGET', P, 'l:' .. user)
  if live then
    redis.call('HDEL', P, 'g:' .. user)
    if live ~= last then
      redis.call('HSET', P, 'l:' .. user, live)
      announce(user, live)
    end
    return 'live'
  end
  if not last then
    redis.call('HDEL', P, 'g:' .. user)
    return 'gone'
  end
  local due = tonumber(redis.call('HGET', P, 'g:' .. user))
  if not due then
    redis.call('HSET', P, 'g:' .. user, string.format('%d', now + grace))
    return 'grace'
  end
  if due <= now then
    redis.call('HDEL', P, 'g:' .. user, 'l:' .. user)
    announce(user, false)
    return 'gone'
  end
  return 'grace'
end
local function keep()
  if redis.call('EXISTS', P) == 1 then redis.call('PEXPIRE', P, ttl) end
end
"#
    };
}

/// `ARGV[3]` pod, `ARGV[4]` user, `ARGV[5]` what the pod's connections of
/// that user add up to, empty for none.
const PRESENCE_UPDATE: &str = concat!(
    presence_prelude!(),
    r"
local field = 'c:' .. ARGV[3] .. '|' .. ARGV[4]
if ARGV[5] == '' then redis.call('HDEL', P, field) else redis.call('HSET', P, field, ARGV[5]) end
local result = settle(ARGV[4])
keep()
return result
"
);

/// `ARGV[3]` user: settle one member, after their grace period.
const PRESENCE_SETTLE: &str = concat!(
    presence_prelude!(),
    r"
local result = settle(ARGV[3])
keep()
return result
"
);

/// Forget what dead pods wrote and settle every member the hub knows.
const PRESENCE_SWEEP: &str = concat!(
    presence_prelude!(),
    r"
local users = {}
for _, field in ipairs(redis.call('HKEYS', P)) do
  local kind = string.sub(field, 1, 2)
  if kind == 'c:' then
    local pod, user = string.match(field, '^c:([^|]*)|(.*)$')
    if pod and not alive[pod] then
      redis.call('HDEL', P, field)
      users[user] = true
    end
  elseif kind == 'l:' or kind == 'g:' then
    users[string.sub(field, 3)] = true
  end
end
local pending = 0
for user in pairs(users) do
  if settle(user) == 'grace' then pending = pending + 1 end
end
keep()
return pending
"
);

/// The members of a room whose pod is alive; the others are dropped.
const ROOM_MEMBERS: &str = r"
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local alive = {}
for _, pod in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], string.format('%d', now), '+inf')) do alive[pod] = true end
local all = redis.call('HGETALL', KEYS[1])
local out = {}
for i = 1, #all, 2 do
  local pod, member = string.match(all[i + 1], '^([^\31]*)\31(.*)$')
  if pod and alive[pod] then out[#out + 1] = member else redis.call('HDEL', KEYS[1], all[i]) end
end
return out
";

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// `_access` out of an event's `data`, as the `WorkspaceHub`'s `handlePublish`
/// takes it: when `data._access` is truthy it leaves `data`, and its
/// `userIds` (strings only) become the recipients. `None`: everyone.
fn take_access(data: &mut Value) -> Option<Vec<String>> {
    let Value::Object(map) = data else {
        return None;
    };
    let truthy = match map.get("_access") {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    };
    if !truthy {
        return None;
    }
    let access = map.remove("_access")?;
    access.get("userIds").and_then(Value::as_array).map(|ids| {
        ids.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

/// Publish one message the way the gateway reads it (see the module docs).
pub(crate) async fn publish(
    connection: &mut ConnectionManager,
    keys: &RealtimeKeys,
    message: &RealtimeMessage,
) -> Result<(), PortError> {
    let channel = message.channel.as_str();
    if channel.starts_with("workspace:") {
        let mut body = message.payload.clone();
        let access = body.get_mut("data").and_then(take_access);
        let access = match access {
            Some(ids) => serde_json::to_string(&ids)?,
            None => String::new(),
        };
        redis::cmd("EVAL")
            .arg(PUBLISH_EVENT)
            .arg(3)
            .arg(keys.seq(channel))
            .arg(keys.log(channel))
            .arg(keys.channel(channel))
            .arg(access)
            .arg(serde_json::to_string(&body)?)
            .arg(millis(REPLAY_TTL))
            .arg(REPLAY_MAX_EVENTS)
            .arg(millis(COUNTER_TTL))
            .query_async::<String>(connection)
            .await
            .map_err(PortError::backend)?;
        return Ok(());
    }
    if channel.starts_with("chat:") && message.payload.get("type") == Some(&Value::from("message"))
    {
        let mut body = message.payload.clone();
        if let Value::Object(map) = &mut body {
            map.remove("seq");
        }
        redis::cmd("EVAL")
            .arg(PUBLISH_CHAT_MESSAGE)
            .arg(2)
            .arg(keys.seq(channel))
            .arg(keys.channel(channel))
            .arg(serde_json::to_string(&body)?)
            .arg(millis(COUNTER_TTL))
            .query_async::<i64>(connection)
            .await
            .map_err(PortError::backend)?;
        return Ok(());
    }
    redis::cmd("PUBLISH")
        .arg(keys.channel(channel))
        .arg(serde_json::to_string(&message.payload)?)
        .query_async::<i64>(connection)
        .await
        .map_err(PortError::backend)?;
    Ok(())
}

/// The members last announced on a hub (`RealtimePublisher.getPresence`).
pub(crate) async fn presence(
    connection: &mut ConnectionManager,
    keys: &RealtimeKeys,
    hub: &str,
    user_ids: &[String],
) -> Result<LivePresence, PortError> {
    let fields: HashMap<String, String> = redis::cmd("HGETALL")
        .arg(keys.presence(hub))
        .query_async(connection)
        .await
        .map_err(PortError::backend)?;
    Ok(fields
        .into_iter()
        .filter_map(|(field, live)| field.strip_prefix("l:").map(|user| (user.to_owned(), live)))
        .filter(|(user, _)| user_ids.is_empty() || user_ids.contains(user))
        .collect::<BTreeMap<_, _>>())
}

// ---------------------------------------------------------------------------
// Reading the wire
// ---------------------------------------------------------------------------

/// One message on a hub's channel.
#[derive(Debug)]
pub enum HubMessage {
    Event(HubEvent),
    /// A member's live presence changed (`None`: offline).
    Presence {
        user_id: String,
        live: Option<String>,
    },
}

/// A stamped workspace event.
#[derive(Debug)]
pub struct HubEvent {
    /// The id's number, for ordering.
    pub seq: u64,
    pub event_id: String,
    pub ts: u64,
    /// `_access.userIds`: only these users receive it.
    pub access: Option<Vec<String>>,
    pub topic: String,
    pub event: String,
    /// `data` exactly as published (`None` when the body had none).
    pub data: Option<Box<RawValue>>,
    pub user_id: Option<String>,
}

#[derive(Deserialize)]
struct WireEnvelope<'a> {
    #[serde(rename = "eventId")]
    event_id: Option<String>,
    ts: Option<u64>,
    access: Option<Vec<String>>,
    #[serde(borrow)]
    body: Option<&'a RawValue>,
    presence: Option<WirePresence>,
}

#[derive(Deserialize)]
struct WirePresence {
    #[serde(rename = "userId")]
    user_id: String,
    live: Option<String>,
}

#[derive(Deserialize)]
struct WireBody {
    topic: Option<String>,
    event: Option<String>,
    data: Option<Box<RawValue>>,
    #[serde(rename = "userId")]
    user_id: Option<String>,
}

/// Parse what a hub's channel (or replay log) carries. `None` for anything
/// else, which the gateway drops.
pub fn parse_hub_message(payload: &[u8]) -> Option<HubMessage> {
    let envelope: WireEnvelope<'_> = serde_json::from_slice(payload).ok()?;
    if let Some(presence) = envelope.presence {
        return Some(HubMessage::Presence {
            user_id: presence.user_id,
            live: presence.live,
        });
    }
    let event_id = envelope.event_id?;
    let seq = event_id.parse().ok()?;
    let body: WireBody = serde_json::from_str(envelope.body?.get()).ok()?;
    Some(HubMessage::Event(HubEvent {
        seq,
        event_id,
        ts: envelope.ts.unwrap_or_default(),
        access: envelope.access,
        topic: body.topic.unwrap_or_default(),
        event: body.event.unwrap_or_default(),
        data: body.data,
        user_id: body.user_id,
    }))
}

/// One message on a room's channel.
#[derive(Debug, PartialEq, Eq)]
pub enum RoomMessage<'a> {
    /// Published by the backend: every connection gets it as it is.
    Published(&'a str),
    /// Said by a client: everyone but the connection `from` gets it (`None`:
    /// everyone).
    Peer {
        from: Option<&'a str>,
        json: &'a str,
    },
}

/// Parse what a room's channel carries.
pub fn parse_room_message(payload: &[u8]) -> Option<RoomMessage<'_>> {
    let text = std::str::from_utf8(payload).ok()?;
    if let Some(peer) = text.strip_prefix('P') {
        let (from, json) = peer.split_once('\n')?;
        return Some(RoomMessage::Peer {
            from: (!from.is_empty()).then_some(from),
            json,
        });
    }
    Some(RoomMessage::Published(text))
}

/// What [`ValkeyBackplane::replay`] read: the hub's counter and the logged
/// events from the cursor on (inclusive), oldest first.
#[derive(Debug, Default)]
pub struct ReplayRead {
    pub counter: u64,
    pub entries: Vec<Vec<u8>>,
}

/// Where a member's presence stands after a change ([`ValkeyBackplane::presence_update`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    /// Connected somewhere.
    Live,
    /// No connection left; offline once the grace period is over unless one
    /// opens. Settle again after [`OFFLINE_GRACE`].
    Grace,
    /// Offline (announced, or never was online).
    Gone,
}

impl Settled {
    fn from_reply(reply: &str) -> Self {
        match reply {
            "live" => Self::Live,
            "grace" => Self::Grace,
            _ => Self::Gone,
        }
    }
}

// ---------------------------------------------------------------------------
// The backplane the gateway runs on
// ---------------------------------------------------------------------------

/// What the backplane hands the gateway.
pub trait BackplaneHandler: Send + Sync + 'static {
    /// A message on `channel` (without the prefix). Called on the
    /// subscription's own task: return quickly, never block.
    fn message(&self, channel: &str, payload: &[u8]);
    /// The subscription was lost and is back: messages in between are gone.
    fn resubscribed(&self);
}

enum Control {
    Subscribe(String, oneshot::Sender<bool>),
    Unsubscribe(String),
    Reconnect,
    Stop,
}

/// The gateway's side of the backplane: one subscription connection, kept
/// alive and resubscribed by a task of its own, and a command connection.
#[derive(Clone)]
pub struct ValkeyBackplane {
    keys: RealtimeKeys,
    commands: ConnectionManager,
    pod: Arc<str>,
    control: mpsc::UnboundedSender<Control>,
}

impl std::fmt::Debug for ValkeyBackplane {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ValkeyBackplane")
            .field("keys", &self.keys)
            .field("pod", &self.pod)
            .finish_non_exhaustive()
    }
}

impl ValkeyBackplane {
    /// Connect to Valkey at `url`, check this pod in as `pod` (no `|`), and
    /// start delivering subscribed channels to `handler`.
    pub async fn start(
        url: &str,
        prefix: &str,
        pod: &str,
        handler: Arc<dyn BackplaneHandler>,
    ) -> Result<Self, PortError> {
        let commands = crate::connect_valkey(url).await?;
        let client = redis::Client::open(url).map_err(PortError::backend)?;
        let keys = RealtimeKeys::new(prefix);
        let (control, receiver) = mpsc::unbounded_channel();
        let backplane = Self {
            keys: keys.clone(),
            commands,
            pod: Arc::from(pod),
            control,
        };
        backplane.check_in().await?;
        tokio::spawn(supervise(client, keys, receiver, handler));
        let heartbeat = backplane.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(POD_HEARTBEAT);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                if heartbeat.control.is_closed() {
                    return;
                }
                if let Err(error) = heartbeat.check_in().await {
                    tracing::warn!(%error, "realtime: pod check-in failed");
                }
            }
        });
        Ok(backplane)
    }

    pub fn keys(&self) -> &RealtimeKeys {
        &self.keys
    }

    /// This pod's id in the registry.
    pub fn pod(&self) -> &str {
        &self.pod
    }

    async fn check_in(&self) -> Result<(), PortError> {
        let mut connection = self.commands.clone();
        redis::cmd("EVAL")
            .arg(POD_CHECK_IN)
            .arg(1)
            .arg(self.keys.pods())
            .arg(&*self.pod)
            .arg(millis(POD_TTL))
            .query_async::<i64>(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(())
    }

    /// Leave the registry (on shutdown): the other pods stop counting this
    /// pod's connections at once instead of after [`POD_TTL`].
    pub async fn check_out(&self) -> Result<(), PortError> {
        let mut connection = self.commands.clone();
        redis::cmd("ZREM")
            .arg(self.keys.pods())
            .arg(&*self.pod)
            .query_async::<i64>(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(())
    }

    /// Start receiving `channel` (counted: as many [`Self::unsubscribe`]
    /// calls stop it). Resolves once Valkey confirmed, or once the
    /// subscription is down (it is restored on reconnect).
    pub async fn subscribe(&self, channel: &str) -> Result<(), PortError> {
        let (ack, confirmed) = oneshot::channel();
        self.control
            .send(Control::Subscribe(channel.to_owned(), ack))
            .map_err(|_| PortError::backend("realtime backplane stopped"))?;
        match confirmed.await {
            Ok(true) => Ok(()),
            _ => Err(PortError::backend("realtime: subscribe failed")),
        }
    }

    pub fn unsubscribe(&self, channel: &str) {
        let _ = self.control.send(Control::Unsubscribe(channel.to_owned()));
    }

    /// Drop the subscription connection and make a new one, as a lost
    /// connection does (the handler hears [`BackplaneHandler::resubscribed`]).
    pub fn reconnect(&self) {
        let _ = self.control.send(Control::Reconnect);
    }

    /// Stop receiving and checking in, as a pod that died would.
    pub fn stop(&self) {
        let _ = self.control.send(Control::Stop);
    }

    /// A hub's replay log from `since` on (inclusive), and its counter.
    pub async fn replay(&self, channel: &str, since: u64) -> Result<ReplayRead, PortError> {
        let mut connection = self.commands.clone();
        let (entries, counter): (Vec<Vec<u8>>, Option<u64>) = redis::pipe()
            .atomic()
            .cmd("ZRANGEBYSCORE")
            .arg(self.keys.log(channel))
            .arg(since)
            .arg("+inf")
            .cmd("GET")
            .arg(self.keys.seq(channel))
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(ReplayRead {
            counter: counter.unwrap_or_default(),
            entries,
        })
    }

    /// A chat room's last `seq` (0 before the first message).
    pub async fn last_seq(&self, channel: &str) -> Result<u64, PortError> {
        let mut connection = self.commands.clone();
        let seq: Option<u64> = redis::cmd("GET")
            .arg(self.keys.seq(channel))
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(seq.unwrap_or_default())
    }

    /// Say `json` in a room: everyone but the connection `from` (`None`:
    /// everyone) gets it, on every pod.
    pub async fn peer(
        &self,
        channel: &str,
        from: Option<&str>,
        json: &str,
    ) -> Result<(), PortError> {
        let mut connection = self.commands.clone();
        redis::cmd("PUBLISH")
            .arg(self.keys.channel(channel))
            .arg(format!("P{}\n{json}", from.unwrap_or_default()))
            .query_async::<i64>(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(())
    }

    fn presence_script(&self, script: &'static str, hub: &str) -> redis::Cmd {
        let mut command = redis::cmd("EVAL");
        command
            .arg(script)
            .arg(3)
            .arg(self.keys.presence(hub))
            .arg(self.keys.channel(&format!("workspace:{hub}")))
            .arg(self.keys.pods())
            .arg(millis(OFFLINE_GRACE))
            .arg(millis(STATE_TTL));
        command
    }

    /// This pod's connections of `user` on `hub` now add up to `live`
    /// (`None`: none left). Announces the member's new presence when it
    /// changed.
    pub async fn presence_update(
        &self,
        hub: &str,
        user: &str,
        live: Option<&str>,
    ) -> Result<Settled, PortError> {
        let mut command = self.presence_script(PRESENCE_UPDATE, hub);
        command
            .arg(&*self.pod)
            .arg(user)
            .arg(live.unwrap_or_default());
        let mut connection = self.commands.clone();
        let reply: String = command
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(Settled::from_reply(&reply))
    }

    /// Settle a member after their grace period.
    pub async fn presence_settle(&self, hub: &str, user: &str) -> Result<Settled, PortError> {
        let mut command = self.presence_script(PRESENCE_SETTLE, hub);
        command.arg(user);
        let mut connection = self.commands.clone();
        let reply: String = command
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(Settled::from_reply(&reply))
    }

    /// Drop what dead pods left on `hub` and settle everyone; how many are
    /// still in their grace period.
    pub async fn presence_sweep(&self, hub: &str) -> Result<u64, PortError> {
        let command = self.presence_script(PRESENCE_SWEEP, hub);
        let mut connection = self.commands.clone();
        command
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)
    }

    /// Everyone last announced on `hub`: the `snapshot` a `presence`
    /// subscriber gets.
    pub async fn presence_snapshot(&self, hub: &str) -> Result<LivePresence, PortError> {
        let mut connection = self.commands.clone();
        presence(&mut connection, &self.keys, hub, &[]).await
    }

    /// `presence:enter`: `member` (JSON) is in the room.
    pub async fn room_enter(
        &self,
        channel: &str,
        user: &str,
        member: &str,
    ) -> Result<(), PortError> {
        let key = self.keys.members(channel);
        let mut connection = self.commands.clone();
        redis::pipe()
            .cmd("HSET")
            .arg(&key)
            .arg(user)
            .arg(format!("{}\u{1f}{member}", self.pod))
            .ignore()
            .cmd("PEXPIRE")
            .arg(&key)
            .arg(millis(STATE_TTL))
            .ignore()
            .query_async::<()>(&mut connection)
            .await
            .map_err(PortError::backend)
    }

    /// `presence:leave`: whether `user` was in the room.
    pub async fn room_leave(&self, channel: &str, user: &str) -> Result<bool, PortError> {
        let mut connection = self.commands.clone();
        let removed: i64 = redis::cmd("HDEL")
            .arg(self.keys.members(channel))
            .arg(user)
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)?;
        Ok(removed > 0)
    }

    /// The members in a room's presence (JSON each).
    pub async fn room_members(&self, channel: &str) -> Result<Vec<String>, PortError> {
        let mut connection = self.commands.clone();
        redis::cmd("EVAL")
            .arg(ROOM_MEMBERS)
            .arg(2)
            .arg(self.keys.members(channel))
            .arg(self.keys.pods())
            .query_async(&mut connection)
            .await
            .map_err(PortError::backend)
    }
}

/// Keeps one pub/sub connection subscribed to every channel someone holds,
/// reconnecting (and resubscribing) when it drops or stops answering pings.
async fn supervise(
    client: redis::Client,
    keys: RealtimeKeys,
    mut control: mpsc::UnboundedReceiver<Control>,
    handler: Arc<dyn BackplaneHandler>,
) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut connected_before = false;
    let mut delay = Duration::from_millis(200);
    loop {
        let connected = tokio::time::timeout(Duration::from_secs(5), client.get_async_pubsub())
            .await
            .map_err(|_| "timed out".to_owned())
            .and_then(|result| result.map_err(|error| error.to_string()));
        let pubsub = match connected {
            Ok(pubsub) => pubsub,
            Err(error) => {
                tracing::warn!(%error, "realtime: cannot subscribe to Valkey; retrying");
                // Keep counting while down, so the reconnect subscribes to
                // what is held then.
                let pause = tokio::time::sleep(delay);
                tokio::pin!(pause);
                loop {
                    tokio::select! {
                        () = &mut pause => break,
                        command = control.recv() => match command {
                            None | Some(Control::Stop) => return,
                            Some(command) => count_offline(&mut counts, command),
                        },
                    }
                }
                delay = (delay * 2).min(Duration::from_secs(5));
                continue;
            }
        };
        let (mut sink, mut stream) = pubsub.split();
        let held: Vec<String> = counts.keys().map(|channel| keys.channel(channel)).collect();
        if !held.is_empty() && sink.subscribe(&held).await.is_err() {
            continue;
        }
        delay = Duration::from_millis(200);
        if connected_before {
            tracing::info!(
                channels = held.len(),
                "realtime: Valkey subscription restored"
            );
            handler.resubscribed();
        }
        connected_before = true;

        let mut ping = tokio::time::interval(Duration::from_secs(15));
        ping.tick().await;
        loop {
            tokio::select! {
                message = stream.next() => match message {
                    Some(message) => {
                        if let Some(channel) = keys.strip(message.get_channel_name()) {
                            handler.message(channel, message.get_payload_bytes());
                        }
                    }
                    None => break,
                },
                command = control.recv() => match command {
                    None | Some(Control::Stop) => return,
                    Some(Control::Reconnect) => break,
                    Some(Control::Subscribe(channel, ack)) => {
                        let count = counts.entry(channel.clone()).or_insert(0);
                        *count += 1;
                        let ok = *count > 1 || sink.subscribe(keys.channel(&channel)).await.is_ok();
                        let _ = ack.send(ok);
                        if !ok {
                            break;
                        }
                    }
                    Some(Control::Unsubscribe(channel)) => {
                        if release(&mut counts, &channel)
                            && sink.unsubscribe(keys.channel(&channel)).await.is_err()
                        {
                            break;
                        }
                    }
                },
                _ = ping.tick() => {
                    let answer = tokio::time::timeout(
                        Duration::from_secs(5),
                        sink.ping::<redis::Value>(),
                    )
                    .await;
                    if !matches!(answer, Ok(Ok(_))) {
                        break;
                    }
                }
            }
        }
        tracing::warn!("realtime: lost the Valkey subscription; reconnecting");
    }
}

/// Count a (un)subscribe while the connection is down. A subscribe is
/// confirmed at once: it is made when the connection is back.
fn count_offline(counts: &mut HashMap<String, usize>, command: Control) {
    match command {
        Control::Subscribe(channel, ack) => {
            *counts.entry(channel).or_insert(0) += 1;
            let _ = ack.send(true);
        }
        Control::Unsubscribe(channel) => {
            release(counts, &channel);
        }
        Control::Reconnect | Control::Stop => {}
    }
}

/// One holder fewer; true when it was the last.
fn release(counts: &mut HashMap<String, usize>, channel: &str) -> bool {
    match counts.get_mut(channel) {
        Some(count) if *count > 1 => {
            *count -= 1;
            false
        }
        Some(_) => {
            counts.remove(channel);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn access_leaves_the_data_when_truthy() {
        let mut data = json!({ "n": 1, "_access": { "userIds": ["u1", 2, "u2"] } });
        assert_eq!(
            take_access(&mut data),
            Some(vec!["u1".to_owned(), "u2".to_owned()])
        );
        assert_eq!(data, json!({ "n": 1 }));

        let mut empty = json!({ "_access": { "userIds": [] } });
        assert_eq!(take_access(&mut empty), Some(Vec::new()), "nobody");

        let mut without_ids = json!({ "a": 1, "_access": {} });
        assert_eq!(take_access(&mut without_ids), None, "everyone");
        assert_eq!(without_ids, json!({ "a": 1 }), "still stripped");

        let mut falsy = json!({ "a": 1, "_access": null });
        assert_eq!(take_access(&mut falsy), None);
        assert_eq!(
            falsy,
            json!({ "a": 1, "_access": null }),
            "kept, as in JavaScript"
        );

        let mut scalar = json!(5);
        assert_eq!(take_access(&mut scalar), None);
    }

    #[test]
    fn hub_messages_parse() {
        let event = br#"{"eventId":"0000000000000042","ts":1700,"access":["u1"],"body":{"workspaceId":"org_1","topic":"task.t1","event":"updated","data":{"b":1,"a":[2]},"userId":"u9"}}"#;
        let Some(HubMessage::Event(event)) = parse_hub_message(event) else {
            panic!("an event");
        };
        assert_eq!(event.seq, 42);
        assert_eq!(event.event_id, "0000000000000042");
        assert_eq!(event.topic, "task.t1");
        assert_eq!(event.access, Some(vec!["u1".to_owned()]));
        assert_eq!(
            event.data.as_deref().map(RawValue::get),
            Some(r#"{"b":1,"a":[2]}"#),
            "as published"
        );

        let presence = br#"{"presence":{"userId":"u\"1","live":null}}"#;
        let Some(HubMessage::Presence { user_id, live }) = parse_hub_message(presence) else {
            panic!("presence");
        };
        assert_eq!((user_id.as_str(), live), ("u\"1", None));

        assert!(parse_hub_message(b"not json").is_none());
        assert!(parse_hub_message(br#"{"eventId":"x","body":{}}"#).is_none());
    }

    #[test]
    fn room_messages_parse() {
        assert_eq!(
            parse_room_message(br#"{"type":"pin"}"#),
            Some(RoomMessage::Published(r#"{"type":"pin"}"#))
        );
        assert_eq!(
            parse_room_message(b"Pconn-1\n{\"type\":\"typing\"}"),
            Some(RoomMessage::Peer {
                from: Some("conn-1"),
                json: "{\"type\":\"typing\"}"
            })
        );
        assert_eq!(
            parse_room_message(b"P\n{}"),
            Some(RoomMessage::Peer {
                from: None,
                json: "{}"
            })
        );
        assert_eq!(parse_room_message(b"Pno-newline"), None);
    }

    #[test]
    fn counts_release_on_the_last_holder() {
        let mut counts = HashMap::new();
        let (ack, _) = oneshot::channel();
        count_offline(&mut counts, Control::Subscribe("a".to_owned(), ack));
        let (ack, _) = oneshot::channel();
        count_offline(&mut counts, Control::Subscribe("a".to_owned(), ack));
        assert!(!release(&mut counts, "a"));
        assert!(release(&mut counts, "a"));
        assert!(!release(&mut counts, "a"));
    }
}
