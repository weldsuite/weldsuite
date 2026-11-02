//! A workspace hub on this pod: the `WorkspaceHub` Durable Object's
//! connections, subscriptions and fan-out, for the sockets this pod holds.
//! The events come from the hub's Valkey channel, so every pod holding a
//! socket of the workspace delivers them; presence and the replay log live in
//! Valkey (`weldsuite_adapters_oss::realtime`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use axum::extract::ws::Utf8Bytes;
use serde_json::json;
use weldsuite_adapters_oss::realtime::{HubEvent, HubMessage, parse_hub_message};

use crate::outbox::Outbox;
use crate::protocol::{self, now_ms};
use crate::topics::{Allowed, PRESENCE_TOPIC, matching_subscriptions};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A connection's presence report (`ConnectionPresence`): a new connection
/// is active and not in a call.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ConnPresence {
    pub(crate) idle: bool,
    pub(crate) in_call: bool,
}

/// One socket on a hub.
pub(crate) struct HubConn {
    /// This pod's number for it.
    pub(crate) local: u64,
    /// `connectionId`, as `connected` told the client.
    pub(crate) id: String,
    pub(crate) user_id: String,
    pub(crate) allowed: Allowed,
    pub(crate) out: Outbox,
    presence: Mutex<ConnPresence>,
    /// While a `subscribe` with `since` replays, live events wait here
    /// (with their sequence number, 0 for presence) so they follow the
    /// replay instead of overtaking it.
    gate: Mutex<Option<Vec<(u64, Utf8Bytes)>>>,
}

impl HubConn {
    pub(crate) fn new(local: u64, user_id: String, allowed: Allowed, out: Outbox) -> Self {
        Self {
            local,
            id: uuid::Uuid::new_v4().to_string(),
            user_id,
            allowed,
            out,
            presence: Mutex::new(ConnPresence::default()),
            gate: Mutex::new(None),
        }
    }

    pub(crate) fn set_presence(&self, presence: ConnPresence) {
        *lock(&self.presence) = presence;
    }

    fn presence(&self) -> ConnPresence {
        *lock(&self.presence)
    }

    /// A live message for this socket: sent, or held while a replay runs.
    fn push(&self, seq: u64, text: Utf8Bytes) {
        let mut gate = lock(&self.gate);
        match gate.as_mut() {
            Some(waiting) => waiting.push((seq, text)),
            None => {
                self.out.send(text);
            }
        }
    }

    /// Hold live messages until [`Self::release`].
    pub(crate) fn hold(&self) {
        *lock(&self.gate) = Some(Vec::new());
    }

    /// Send what waited, minus the events the replay already sent.
    pub(crate) fn release(&self, replayed: &HashSet<u64>) {
        let mut gate = lock(&self.gate);
        if let Some(waiting) = gate.take() {
            for (seq, text) in waiting {
                if seq == 0 || !replayed.contains(&seq) {
                    self.out.send(text);
                }
            }
        }
    }
}

#[derive(Default)]
struct HubState {
    conns: HashMap<u64, Arc<HubConn>>,
    /// Each connection's topics.
    subs: HashMap<u64, HashSet<String>>,
    /// Topic → the connections subscribed to it.
    index: HashMap<String, HashSet<u64>>,
}

impl HubState {
    fn subscribers(&self, topic: &str) -> Vec<Arc<HubConn>> {
        let mut seen = HashSet::new();
        matching_subscriptions(topic)
            .filter_map(|subscription| self.index.get(subscription))
            .flatten()
            .filter(|local| seen.insert(**local))
            .filter_map(|local| self.conns.get(local).cloned())
            .collect()
    }
}

/// A workspace hub (or a personal account's) on this pod.
pub(crate) struct Hub {
    /// The hub key: the workspace's organization id, `workspaces.id`, or
    /// `personal:<user id>`.
    pub(crate) key: String,
    /// Its Valkey channel, `workspace:<key>`.
    pub(crate) channel: String,
    /// Presence is kept for workspace members only, not personal hubs.
    pub(crate) tracks_presence: bool,
    state: Mutex<HubState>,
    /// What this pod last told Valkey each member's connections add up to;
    /// the lock keeps those reports in order.
    pub(crate) reported: tokio::sync::Mutex<HashMap<String, &'static str>>,
    /// Set once the channel is subscribed.
    pub(crate) ready: tokio::sync::OnceCell<()>,
}

impl Hub {
    pub(crate) fn new(key: &str, tracks_presence: bool) -> Self {
        Self {
            key: key.to_owned(),
            channel: format!("workspace:{key}"),
            tracks_presence,
            state: Mutex::new(HubState::default()),
            reported: tokio::sync::Mutex::new(HashMap::new()),
            ready: tokio::sync::OnceCell::new(),
        }
    }

    pub(crate) fn join(&self, conn: Arc<HubConn>) {
        lock(&self.state).conns.insert(conn.local, conn);
    }

    /// Forget a connection; true when the hub is empty now.
    pub(crate) fn leave(&self, local: u64) -> bool {
        let mut state = lock(&self.state);
        state.conns.remove(&local);
        if let Some(topics) = state.subs.remove(&local) {
            for topic in topics {
                if let Some(locals) = state.index.get_mut(&topic) {
                    locals.remove(&local);
                    if locals.is_empty() {
                        state.index.remove(&topic);
                    }
                }
            }
        }
        state.conns.is_empty()
    }

    pub(crate) fn is_empty(&self) -> bool {
        lock(&self.state).conns.is_empty()
    }

    pub(crate) fn connections(&self) -> Vec<Arc<HubConn>> {
        lock(&self.state).conns.values().cloned().collect()
    }

    /// How many topics the connection holds.
    pub(crate) fn subscription_count(&self, local: u64) -> usize {
        lock(&self.state).subs.get(&local).map_or(0, HashSet::len)
    }

    pub(crate) fn subscribe(&self, local: u64, topics: &[String]) {
        let mut state = lock(&self.state);
        for topic in topics {
            state.subs.entry(local).or_default().insert(topic.clone());
            state.index.entry(topic.clone()).or_default().insert(local);
        }
    }

    pub(crate) fn unsubscribe(&self, local: u64, topics: &[&str]) {
        let mut state = lock(&self.state);
        for topic in topics {
            if let Some(subs) = state.subs.get_mut(&local) {
                subs.remove(*topic);
            }
            if let Some(locals) = state.index.get_mut(*topic) {
                locals.remove(&local);
                if locals.is_empty() {
                    state.index.remove(*topic);
                }
            }
        }
    }

    /// The connection's topics, sorted.
    pub(crate) fn subscriptions(&self, local: u64) -> Vec<String> {
        let mut topics: Vec<String> = lock(&self.state)
            .subs
            .get(&local)
            .map(|subs| subs.iter().cloned().collect())
            .unwrap_or_default();
        topics.sort();
        topics
    }

    /// `aggregateConnections` over the member's sockets on this pod.
    pub(crate) fn live_of(&self, user_id: &str) -> Option<&'static str> {
        let state = lock(&self.state);
        let mine: Vec<ConnPresence> = state
            .conns
            .values()
            .filter(|conn| conn.user_id == user_id)
            .map(|conn| conn.presence())
            .collect();
        if mine.is_empty() {
            None
        } else if mine.iter().any(|p| p.in_call) {
            Some("busy")
        } else if mine.iter().any(|p| !p.idle) {
            Some("online")
        } else {
            Some("away")
        }
    }

    /// A message from the hub's channel.
    pub(crate) fn deliver(&self, payload: &[u8]) {
        match parse_hub_message(payload) {
            Some(HubMessage::Event(event)) => self.deliver_event(&event),
            Some(HubMessage::Presence { user_id, live }) => {
                if self.tracks_presence {
                    self.deliver_presence(&user_id, live.as_deref());
                }
            }
            None => tracing::warn!(hub = %self.key, "realtime: unreadable hub message dropped"),
        }
    }

    /// `handlePublish`'s fan-out: to every subscriber of the topic, only to
    /// the listed users when the event has an access list.
    fn deliver_event(&self, event: &HubEvent) {
        let targets = lock(&self.state).subscribers(&event.topic);
        if targets.is_empty() {
            return;
        }
        let text = Utf8Bytes::from(protocol::event(event));
        for conn in targets {
            if may_receive(event, &conn.user_id) {
                conn.push(event.seq, text.clone());
            }
        }
    }

    /// `broadcastPresence`: `connection_changed` to every `presence`
    /// subscriber.
    fn deliver_presence(&self, user_id: &str, live: Option<&str>) {
        let targets = lock(&self.state).subscribers(PRESENCE_TOPIC);
        if targets.is_empty() {
            return;
        }
        let text = Utf8Bytes::from(protocol::presence_event(
            "connection_changed",
            &json!({ "userId": user_id, "live": live }),
            user_id,
            now_ms(),
        ));
        for conn in targets {
            conn.push(0, text.clone());
        }
    }
}

/// The access list check of `handlePublish` and `replaySince`.
pub(crate) fn may_receive(event: &HubEvent, user_id: &str) -> bool {
    event
        .access
        .as_ref()
        .is_none_or(|users| users.iter().any(|user| user == user_id))
}
