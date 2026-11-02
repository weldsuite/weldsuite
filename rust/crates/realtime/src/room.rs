//! A room on this pod: the `ChatRoom`, `SupportRoom` and `ConversationRoom`
//! Durable Objects for the sockets this pod holds. What the backend
//! publishes and what clients say (typing, room presence) both arrive on the
//! room's Valkey channel, so every pod holding a socket of the room relays
//! them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use axum::extract::ws::Utf8Bytes;
use weldsuite_adapters_oss::realtime::{RoomMessage, parse_room_message};

use crate::outbox::Outbox;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Which Durable Object a room stands in for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RoomKind {
    /// A WeldChat channel or DM (`/ws/chat/:channelId`).
    Chat,
    /// A workspace's enterprise support channel (`/ws/support/:workspaceId`).
    Support,
    /// A helpdesk conversation (`/ws/conversation/:conversationId`).
    Conversation,
}

impl RoomKind {
    pub(crate) fn channel(self, id: &str) -> String {
        let prefix = match self {
            Self::Chat => "chat",
            Self::Support => "support",
            Self::Conversation => "conversation",
        };
        format!("{prefix}:{id}")
    }
}

/// One socket in a room, with the identity the realtime-worker put in its
/// tags.
pub(crate) struct RoomConn {
    pub(crate) local: u64,
    pub(crate) id: String,
    pub(crate) user_id: String,
    pub(crate) user_name: String,
    pub(crate) role: String,
    pub(crate) can_publish: bool,
    pub(crate) out: Outbox,
}

/// A room on this pod.
pub(crate) struct Room {
    pub(crate) kind: RoomKind,
    /// Its Valkey channel (`chat:<id>`).
    pub(crate) channel: String,
    conns: Mutex<HashMap<u64, Arc<RoomConn>>>,
    /// The typing timer of each member typing through this pod.
    typing: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    /// Set once the channel is subscribed.
    pub(crate) ready: tokio::sync::OnceCell<()>,
}

impl Room {
    pub(crate) fn new(kind: RoomKind, channel: String) -> Self {
        Self {
            kind,
            channel,
            conns: Mutex::new(HashMap::new()),
            typing: Mutex::new(HashMap::new()),
            ready: tokio::sync::OnceCell::new(),
        }
    }

    pub(crate) fn join(&self, conn: Arc<RoomConn>) {
        lock(&self.conns).insert(conn.local, conn);
    }

    /// Forget a connection; true when the room is empty now.
    pub(crate) fn leave(&self, local: u64) -> bool {
        let mut conns = lock(&self.conns);
        conns.remove(&local);
        conns.is_empty()
    }

    pub(crate) fn is_empty(&self) -> bool {
        lock(&self.conns).is_empty()
    }

    pub(crate) fn connections(&self) -> Vec<Arc<RoomConn>> {
        lock(&self.conns).values().cloned().collect()
    }

    /// A message from the room's channel: what the backend published goes to
    /// everyone; what a client said to everyone but that client.
    pub(crate) fn deliver(&self, payload: &[u8]) {
        let (text, from) = match parse_room_message(payload) {
            Some(RoomMessage::Published(text)) => (text, None),
            Some(RoomMessage::Peer { from, json }) => (json, from),
            None => {
                tracing::warn!(room = %self.channel, "realtime: unreadable room message dropped");
                return;
            }
        };
        let text = Utf8Bytes::from(text);
        for conn in self.connections() {
            if from != Some(conn.id.as_str()) {
                conn.out.send(text.clone());
            }
        }
    }

    /// Replace a member's typing timer.
    pub(crate) fn set_typing_timer(&self, user_id: &str, timer: tokio::task::AbortHandle) {
        if let Some(previous) = lock(&self.typing).insert(user_id.to_owned(), timer) {
            previous.abort();
        }
    }

    /// Stop a member's typing timer, if any.
    pub(crate) fn clear_typing_timer(&self, user_id: &str) {
        if let Some(timer) = lock(&self.typing).remove(user_id) {
            timer.abort();
        }
    }

    /// The timer fired: forget it without aborting (it is finishing).
    pub(crate) fn typing_timer_done(&self, user_id: &str) {
        lock(&self.typing).remove(user_id);
    }
}
