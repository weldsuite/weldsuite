//! WeldChat: chat-api's routes (`apps/workers/chat-api`), each object at its
//! own `/api` prefix, as the worker mounts them:
//!
//! | Router | Prefix | TypeScript |
//! |---|---|---|
//! | [`channel_members`] | `/api/channel-members` | `routes/channel-members` |
//! | [`channels`] | `/api/channels` | `routes/channels` |
//! | [`bookmarks`] | `/api/chat-bookmarks` | `routes/chat-bookmarks` |
//! | [`drafts`] | `/api/chat-drafts` | `routes/chat-drafts` |
//! | [`sections`] | `/api/chat-sections` | `routes/chat-sections` |
//! | [`status`] | `/api/chat-status` | `routes/chat-status` |
//! | [`messages`] | `/api/chat-messages` | `routes/chat-messages` |
//! | [`calls`] | `/api/chat-calls` | `routes/chat-calls` |
//! | [`public_calls`] | `/public/chat-calls` | `routes/chat-calls/public-decline.ts` |
//!
//! Who may read a channel is `weldsuite-chat-domain`'s; the realtime fan-out
//! goes through the realtime port with the TypeScript payloads, and
//! notifications through `weldsuite-notifications`. Calls run on the video
//! provider port (`RealtimeKit` on Global and in conformance, `LiveKit` on
//! the Kubernetes editions).

#![allow(clippy::too_many_lines, clippy::type_complexity)]

mod access;
mod calls;
mod followers;
mod forward;
mod groups;
mod pins;
mod post;
mod reads;
mod util;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use weldsuite_db::PgPool;
use weldsuite_events::EntityEventPublisher;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::video_rooms::DynVideoRooms;
use weldsuite_ports::{
    BoxFuture, DynCache, DynJobs, DynRealtimePublisher, FileStores, OutboundHttp, PresenceReader,
};

pub use access::{Caller, ChatError, ChatResult};
pub use calls::{CALL_RING_TIMEOUT_JOB, CallRingTimeoutJob};
pub use pins::{TenantDatabases, UNPIN_EXPIRED_MESSAGE_JOB, UnpinExpiredMessageJob};

/// What WeldMeet's half of "one live call at a time" needs when a user joins
/// a call (`leaveOtherMeetingSessions(db, env, orgId, userId, null, { triggeredAt })`):
/// the request's provider and cache, so conformance reaches the test's.
pub struct LeaveMeetings {
    pub db: PgPool,
    pub video: Arc<dyn DynVideoRooms>,
    pub cache: Option<Arc<dyn DynCache>>,
    pub org_id: String,
    pub user_id: String,
    /// When the joining request started: a meeting joined after it is kept.
    pub triggered_at: i64,
}

/// Leaves the user's other meeting sessions; the app wires it to meet (the
/// modules never depend on each other). Never fails.
pub type MeetingSessionsLeaver = Arc<dyn Fn(LeaveMeetings) -> BoxFuture<'static, ()> + Send + Sync>;

/// What the handlers share, cloned from the app state.
#[derive(Clone)]
pub struct ChatState {
    pub events: EntityEventPublisher,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// `WORKSPACE_CACHE` (rate limits, call bookkeeping). Conformance builds
    /// pass none: a test without a KV namespace has no rate limit, as a
    /// worker without the binding.
    pub cache: Option<Arc<dyn DynCache>>,
    /// The `STORAGE` bucket (attachments, clips) as the public store.
    pub files: Option<FileStores>,
    /// Delayed jobs (the pin auto-expiry).
    pub jobs: Option<Arc<dyn DynJobs>>,
    /// Whether a pin with an expiry starts the auto-unpin job (the workers'
    /// `UNPIN_EXPIRED_MESSAGE` binding; their tests run without it).
    pub unpin_jobs: bool,
    /// Third-party HTTP (Expo push, APNs).
    pub http: Option<OutboundHttp>,
    /// Live presence from the realtime hub.
    pub presence: Option<PresenceReader>,
    /// Settings the worker reads from its env: `R2_PUBLIC_URL`,
    /// `PUBLIC_APP_URL`, `CALL_RING_SECRET`, `APNS_*`.
    pub env: Arc<HashMap<String, String>>,
    /// The video provider behind calls (`weldsuite_video_rooms::from_env`).
    /// Conformance builds pass none: they use `RealtimeKit` with the test's
    /// credentials through the request's outbound bridge.
    pub video: Option<Arc<dyn DynVideoRooms>>,
    /// WeldMeet's half of "one live call at a time"; `None` leaves meetings
    /// alone.
    pub leave_meetings: Option<MeetingSessionsLeaver>,
    /// Whether a DM call starts the ring timeout job; the worker's tests mock
    /// `scheduleRingTimeout`, so conformance builds run without it.
    pub ring_jobs: bool,
    /// Workspaces' tenant databases, for the public ring decline (by the
    /// token's workspace). Conformance passes the test's on the request.
    pub tenants: Option<TenantDatabases>,
}

impl std::fmt::Debug for ChatState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatState")
            .field("events", &self.events)
            .field("realtime", &self.realtime.is_some())
            .field("cache", &self.cache.is_some())
            .field("files", &self.files.is_some())
            .field("jobs", &self.jobs.is_some())
            .finish_non_exhaustive()
    }
}

macro_rules! group_router {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        pub fn $name<S, Q>(state: ChatState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
        where
            S: Clone + Send + Sync + 'static,
            Q: PermissionQueries + 'static,
        {
            groups::$name::router(gate).with_state(state)
        }
    };
}

group_router!(
    /// `/api/channel-members`: single-row membership CRUD.
    channel_members
);
group_router!(
    /// `/api/channels`: channels, their messages, members, agents, reads.
    channels
);
group_router!(
    /// `/api/chat-messages`: messages, threads, reactions, pins, uploads.
    messages
);
group_router!(
    /// `/api/chat-bookmarks`: the caller's saved messages.
    bookmarks
);
group_router!(
    /// `/api/chat-drafts`: the caller's unsent messages.
    drafts
);
group_router!(
    /// `/api/chat-sections`: the sidebar's channel groups.
    sections
);
group_router!(
    /// `/api/chat-status`: chosen status and live presence.
    status
);
group_router!(
    /// `/api/chat-activity`: the caller's WeldChat notifications.
    activity
);
group_router!(
    /// `/api/chat-dm`: direct messages.
    dm
);

/// `/api/chat-directories`: the channel browser.
pub fn directories<S, Q>(state: ChatState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    groups::directories::directories_router(gate).with_state(state)
}

/// `/api/chat-search`: message search.
pub fn search<S, Q>(state: ChatState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    groups::directories::search_router(gate).with_state(state)
}
group_router!(
    /// `/api/chat-entity-channels`: record chats.
    record_chats
);

/// `/api/chat-calls`: voice and video calls.
pub fn calls<S, Q>(state: ChatState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    calls::router(gate).with_state(state)
}

/// `/public/chat-calls`: declining a ring from the phone's lock screen,
/// served ahead of the session (the ring token is the credential).
pub fn public_calls<S>(state: ChatState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    calls::public_router().with_state(state)
}
group_router!(
    /// `/api/chat-clips`: clip transcripts.
    clips
);
