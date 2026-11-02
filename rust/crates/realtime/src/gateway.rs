//! The gateway: this pod's hubs and rooms, the Valkey backplane they hang
//! on, and the limits.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use weldsuite_adapters_oss::realtime::{
    BackplaneHandler, HubEvent, HubMessage, OFFLINE_GRACE, Settled, ValkeyBackplane,
    parse_hub_message,
};
use weldsuite_adapters_oss::{ValkeyRealtime, connect_valkey};
use weldsuite_auth::{AuthContext, SessionVerifier, TokenError};
use weldsuite_ports::{BoxFuture, PortError};

use crate::config::GatewayConfig;
use crate::directory::Directory;
use crate::hub::{Hub, may_receive};
use crate::protocol;
use crate::room::{Room, RoomKind};
use crate::topics::topic_matches;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Verifies the session token a socket presents.
pub trait Authenticator: Send + Sync + 'static {
    fn authenticate<'a>(&'a self, token: &'a str)
    -> BoxFuture<'a, Result<AuthContext, TokenError>>;
}

impl Authenticator for SessionVerifier {
    fn authenticate<'a>(
        &'a self,
        token: &'a str,
    ) -> BoxFuture<'a, Result<AuthContext, TokenError>> {
        let now = protocol::now_ms() / 1000;
        Box::pin(self.verify(token, now))
    }
}

/// The hubs and rooms with a socket on this pod; what the backplane delivers
/// to.
#[derive(Default)]
pub(crate) struct Registry {
    hubs: Mutex<HashMap<String, Arc<Hub>>>,
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    open: AtomicUsize,
    per_user: Mutex<HashMap<String, usize>>,
}

impl BackplaneHandler for Registry {
    fn message(&self, channel: &str, payload: &[u8]) {
        if let Some(key) = channel.strip_prefix("workspace:") {
            let hub = lock(&self.hubs).get(key).cloned();
            if let Some(hub) = hub {
                hub.deliver(payload);
            }
        } else {
            let room = lock(&self.rooms).get(channel).cloned();
            if let Some(room) = room {
                room.deliver(payload);
            }
        }
    }

    /// Messages were lost while the subscription was down: every hub socket
    /// is told to refetch what it watches (`resync_required`, as for a
    /// cursor past the replay window), and room sockets are closed so their
    /// clients reconnect and check `lastSeq` for gaps.
    fn resubscribed(&self) {
        let hubs: Vec<Arc<Hub>> = lock(&self.hubs).values().cloned().collect();
        for hub in hubs {
            for conn in hub.connections() {
                let topics = hub.subscriptions(conn.local);
                if !topics.is_empty() {
                    conn.out.text(protocol::resync_required(&topics));
                }
            }
        }
        let rooms: Vec<Arc<Room>> = lock(&self.rooms).values().cloned().collect();
        for room in rooms {
            for conn in room.connections() {
                conn.out.close(protocol::RESTART, "resubscribe");
            }
        }
    }
}

/// An open socket counted against the limits; uncounted when dropped.
pub(crate) struct Admission {
    registry: Arc<Registry>,
    user: String,
}

impl Drop for Admission {
    fn drop(&mut self) {
        self.registry.open.fetch_sub(1, Ordering::Relaxed);
        let mut per_user = lock(&self.registry.per_user);
        if let Some(count) = per_user.get_mut(&self.user) {
            *count -= 1;
            if *count == 0 {
                per_user.remove(&self.user);
            }
        }
    }
}

/// What a `subscribe` with `since` replays.
pub(crate) enum Replay {
    Events(Vec<HubEvent>),
    /// The cursor is older than the log: refetch.
    Resync,
}

/// The realtime WebSocket gateway of one pod.
pub struct Gateway {
    pub(crate) config: GatewayConfig,
    pub(crate) auth: Arc<dyn Authenticator>,
    pub(crate) directory: Arc<dyn Directory>,
    pub(crate) backplane: ValkeyBackplane,
    pub(crate) publisher: ValkeyRealtime,
    pub(crate) registry: Arc<Registry>,
    next_local: AtomicU64,
}

impl std::fmt::Debug for Gateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gateway")
            .field("config", &self.config)
            .field("backplane", &self.backplane)
            .finish_non_exhaustive()
    }
}

/// A pod id for the registry: the host name and a random part, without
/// the separators the presence state uses.
fn pod_id() -> String {
    let host: String = std::env::var("HOSTNAME")
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '.' || *c == '_')
        .take(60)
        .collect();
    let random = uuid::Uuid::new_v4().simple().to_string();
    if host.is_empty() {
        random
    } else {
        format!("{host}-{}", &random[..8])
    }
}

impl Gateway {
    /// Connect to Valkey at `valkey_url` (channels and state under `prefix`,
    /// the publisher's `VALKEY_REALTIME_PREFIX`) and start serving.
    pub async fn start(
        config: GatewayConfig,
        auth: Arc<dyn Authenticator>,
        directory: Arc<dyn Directory>,
        valkey_url: &str,
        prefix: &str,
    ) -> Result<Arc<Self>, PortError> {
        let registry = Arc::new(Registry::default());
        let handler: Arc<dyn BackplaneHandler> = registry.clone();
        let backplane = ValkeyBackplane::start(valkey_url, prefix, &pod_id(), handler).await?;
        let publisher = ValkeyRealtime::new(connect_valkey(valkey_url).await?, prefix);
        let gateway = Arc::new(Self {
            config,
            auth,
            directory,
            backplane,
            publisher,
            registry,
            next_local: AtomicU64::new(1),
        });
        tokio::spawn(sweep(Arc::downgrade(&gateway)));
        tracing::info!(pod = gateway.backplane.pod(), "realtime: gateway started");
        Ok(gateway)
    }

    pub(crate) fn next_local(&self) -> u64 {
        self.next_local.fetch_add(1, Ordering::Relaxed)
    }

    /// Count a new socket of `user`, or `None` past a limit.
    pub(crate) fn admit(&self, user: &str) -> Option<Admission> {
        let registry = &self.registry;
        let mut per_user = lock(&registry.per_user);
        let mine = per_user.get(user).copied().unwrap_or_default();
        if mine >= self.config.max_connections_per_user {
            return None;
        }
        if registry.open.fetch_add(1, Ordering::Relaxed) >= self.config.max_connections {
            registry.open.fetch_sub(1, Ordering::Relaxed);
            return None;
        }
        per_user.insert(user.to_owned(), mine + 1);
        Some(Admission {
            registry: Arc::clone(registry),
            user: user.to_owned(),
        })
    }

    /// The open sockets on this pod.
    pub fn open_connections(&self) -> usize {
        self.registry.open.load(Ordering::Relaxed)
    }

    /// The Valkey side of this pod.
    pub fn backplane(&self) -> &ValkeyBackplane {
        &self.backplane
    }

    /// Settle what dead pods left on every hub this pod holds; runs every
    /// [`GatewayConfig::sweep_every`] on its own.
    pub async fn sweep(&self) {
        for hub in self.presence_hubs() {
            if let Err(error) = self.backplane.presence_sweep(&hub).await {
                tracing::warn!(%error, %hub, "realtime: presence sweep failed");
            }
        }
    }

    /// The hub `key`, created on first use; `join` runs under the registry's
    /// lock so a hub is never retired between finding and joining it.
    pub(crate) fn hub(
        &self,
        key: &str,
        tracks_presence: bool,
        join: impl FnOnce(&Hub),
    ) -> Arc<Hub> {
        let mut hubs = lock(&self.registry.hubs);
        let hub = hubs
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(Hub::new(key, tracks_presence)))
            .clone();
        join(&hub);
        hub
    }

    /// Subscribe the hub's channel (once); a new presence hub first settles
    /// what dead pods left there, so its first snapshot is right.
    pub(crate) async fn ready_hub(&self, hub: &Hub) -> Result<(), PortError> {
        hub.ready
            .get_or_try_init(|| async {
                self.backplane.subscribe(&hub.channel).await?;
                if hub.tracks_presence
                    && let Err(error) = self.backplane.presence_sweep(&hub.key).await
                {
                    tracing::warn!(%error, hub = %hub.key, "realtime: presence sweep failed");
                }
                Ok::<(), PortError>(())
            })
            .await?;
        Ok(())
    }

    /// After a socket left: retire the hub once it has stayed empty for
    /// [`GatewayConfig::linger`].
    pub(crate) fn retire_hub_later(self: &Arc<Self>, hub: &Arc<Hub>) {
        let gateway = Arc::clone(self);
        let hub = Arc::clone(hub);
        tokio::spawn(async move {
            tokio::time::sleep(gateway.config.linger).await;
            let retired = {
                let mut hubs = lock(&gateway.registry.hubs);
                let current = hubs.get(&hub.key).is_some_and(|h| Arc::ptr_eq(h, &hub));
                if current && hub.is_empty() {
                    hubs.remove(&hub.key);
                    true
                } else {
                    false
                }
            };
            if retired && hub.ready.initialized() {
                gateway.backplane.unsubscribe(&hub.channel);
            }
        });
    }

    pub(crate) fn room(&self, kind: RoomKind, id: &str, join: impl FnOnce(&Room)) -> Arc<Room> {
        let channel = kind.channel(id);
        let mut rooms = lock(&self.registry.rooms);
        let room = rooms
            .entry(channel.clone())
            .or_insert_with(|| Arc::new(Room::new(kind, channel)))
            .clone();
        join(&room);
        room
    }

    pub(crate) async fn ready_room(&self, room: &Room) -> Result<(), PortError> {
        room.ready
            .get_or_try_init(|| self.backplane.subscribe(&room.channel))
            .await?;
        Ok(())
    }

    pub(crate) fn retire_room_later(self: &Arc<Self>, room: &Arc<Room>) {
        let gateway = Arc::clone(self);
        let room = Arc::clone(room);
        tokio::spawn(async move {
            tokio::time::sleep(gateway.config.linger).await;
            let retired = {
                let mut rooms = lock(&gateway.registry.rooms);
                let current = rooms
                    .get(&room.channel)
                    .is_some_and(|r| Arc::ptr_eq(r, &room));
                if current && room.is_empty() {
                    rooms.remove(&room.channel);
                    true
                } else {
                    false
                }
            };
            if retired && room.ready.initialized() {
                gateway.backplane.unsubscribe(&room.channel);
            }
        });
    }

    /// `refreshPresence`: tell Valkey what the member's sockets on this pod
    /// add up to when that changed, and settle them once their grace period
    /// is over when none is left.
    pub(crate) async fn refresh_presence(self: &Arc<Self>, hub: &Arc<Hub>, user_id: &str) {
        if !hub.tracks_presence || user_id.is_empty() {
            return;
        }
        let mut reported = hub.reported.lock().await;
        let live = hub.live_of(user_id);
        if reported.get(user_id).copied() == live {
            return;
        }
        match self
            .backplane
            .presence_update(&hub.key, user_id, live)
            .await
        {
            Ok(settled) => {
                match live {
                    Some(live) => reported.insert(user_id.to_owned(), live),
                    None => reported.remove(user_id),
                };
                if settled == Settled::Grace {
                    self.settle_later(&hub.key, user_id);
                }
            }
            Err(error) => {
                tracing::warn!(%error, hub = %hub.key, "realtime: presence update failed");
            }
        }
    }

    fn settle_later(self: &Arc<Self>, hub: &str, user_id: &str) {
        let gateway = Arc::clone(self);
        let (hub, user_id) = (hub.to_owned(), user_id.to_owned());
        tokio::spawn(async move {
            for _ in 0..3 {
                tokio::time::sleep(OFFLINE_GRACE + Duration::from_millis(250)).await;
                match gateway.backplane.presence_settle(&hub, &user_id).await {
                    Ok(Settled::Grace) => {}
                    Ok(_) => return,
                    Err(error) => {
                        tracing::warn!(%error, %hub, "realtime: settling presence failed");
                        return;
                    }
                }
            }
        });
    }

    /// `replaySince`: the logged events after `since` on the hub, for the
    /// accepted topics and this user, or [`Replay::Resync`] when the log no
    /// longer reaches back that far.
    pub(crate) async fn replay(
        &self,
        hub: &Hub,
        since: &str,
        topics: &[String],
        user_id: &str,
    ) -> Replay {
        let Ok(since) = since.parse::<u64>() else {
            return Replay::Resync;
        };
        let read = match self.backplane.replay(&hub.channel, since).await {
            Ok(read) => read,
            Err(error) => {
                tracing::warn!(%error, hub = %hub.key, "realtime: replay read failed");
                return Replay::Resync;
            }
        };
        let events: Vec<HubEvent> = read
            .entries
            .iter()
            .filter_map(|entry| match parse_hub_message(entry) {
                Some(HubMessage::Event(event)) => Some(event),
                _ => None,
            })
            .collect();
        let Some(first) = events.first() else {
            return if since >= read.counter {
                Replay::Events(Vec::new())
            } else {
                Replay::Resync
            };
        };
        if first.seq > since && first.seq != since + 1 {
            return Replay::Resync;
        }
        Replay::Events(
            events
                .into_iter()
                .filter(|event| event.seq != since)
                .filter(|event| {
                    topics
                        .iter()
                        .any(|topic| topic_matches(topic, &event.topic))
                })
                .filter(|event| may_receive(event, user_id))
                .collect(),
        )
    }

    /// Close every socket (1012) and leave the pod registry: for shutdown.
    /// Clients reconnect to another pod within the presence grace period.
    pub async fn shutdown(&self) {
        let hubs: Vec<Arc<Hub>> = lock(&self.registry.hubs).values().cloned().collect();
        let rooms: Vec<Arc<Room>> = lock(&self.registry.rooms).values().cloned().collect();
        for hub in &hubs {
            for conn in hub.connections() {
                conn.out.close(protocol::RESTART, "service restart");
            }
        }
        for room in &rooms {
            for conn in room.connections() {
                conn.out.close(protocol::RESTART, "service restart");
            }
        }
        // Let the sockets report their presence on the way out.
        for _ in 0..20 {
            if self.open_connections() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if let Err(error) = self.backplane.check_out().await {
            tracing::warn!(%error, "realtime: leaving the pod registry failed");
        }
        self.backplane.stop();
    }

    /// The hubs with presence that have a socket on this pod.
    fn presence_hubs(&self) -> Vec<String> {
        lock(&self.registry.hubs)
            .values()
            .filter(|hub| hub.tracks_presence)
            .map(|hub| hub.key.clone())
            .collect()
    }
}

/// Every [`GatewayConfig::sweep_every`]: settle what dead pods left on the
/// hubs this pod holds (`sweepConnections` for the pods that died).
async fn sweep(gateway: std::sync::Weak<Gateway>) {
    let every = match gateway.upgrade() {
        Some(gateway) => gateway.config.sweep_every,
        None => return,
    };
    let mut tick = tokio::time::interval(every);
    tick.tick().await;
    loop {
        tick.tick().await;
        let Some(gateway) = gateway.upgrade() else {
            return;
        };
        gateway.sweep().await;
    }
}
