//! The infrastructure the backend talks to, as traits (ports), so a module
//! never names Valkey, NATS or a Cloudflare binding. The Kubernetes editions
//! plug in the open-source adapters of `weldsuite-adapters-oss`; tests plug in
//! the in-memory doubles here, which record what was sent so the conformance
//! suite can diff side effects between the TypeScript and Rust backends.
//!
//! | Port | Replaces (TypeScript workers) | Double |
//! |---|---|---|
//! | [`Cache`] | the `WORKSPACE_CACHE` KV namespace | [`MemoryCache`] |
//! | [`EventBus`] | the `ENTITY_EVENTS` hub queue | [`RecordingEventBus`] |
//! | [`RealtimePublisher`] | `RealtimePublisher` over the `REALTIME` service binding (`@weldsuite/realtime/server`) | [`RecordingRealtime`] |
//! | [`FileStore`] | the `PRIVATE_STORAGE` and `STORAGE` R2 buckets (`@weldsuite/worker-kit/storage`) | [`MemoryFileStore`] |
//! | [`SystemMail`] | the `SEND_EMAIL` binding behind `@weldsuite/emails` (`workerTransport`) | [`RecordingSystemMail`] |
//! | [`FlagSource`] | the Cloudflare Flagship binding (`@weldsuite/feature-flags/server`) | [`StaticFlags`] |
//! | [`Identity`] | Clerk's Backend API (`api.clerk.com/v1`, `@clerk/backend`), ADR SEC-012 | [`MemoryIdentity`] |
//! | [`MailTransport`] | customer mail over the `SEND_EMAIL` binding (`@weldsuite/worker-email`), ADR MAIL-010 | [`RecordingMailTransport`] |
//! | [`LedgerStore`] | the `OutboundLedger` / `OutboundPlatformBudget` Durable Objects' storage (MAIL-006) | [`MemoryLedgerStore`] |
//!
//! Every port is a trait with native `async fn`-style methods
//! (`impl Future + Send`). Those are not object safe, so each also has a
//! `Dyn*` twin with boxed futures, implemented for every port, for state that
//! picks its adapter at runtime: `Arc<dyn DynCache>` and friends implement the
//! port trait again. [`Identity`] is object safe from the start (see its
//! module).

use std::fmt;
use std::pin::Pin;

pub mod cache;
pub mod events;
pub mod files;
pub mod flags;
pub mod identity;
pub mod in_process_jobs;
pub mod jobs;
pub mod ledger_store;
pub mod mail;
pub mod outbound;
pub mod presence;
pub mod realtime;
pub mod video_rooms;
pub mod transport;

pub use cache::{Cache, CacheExt, DynCache, MemoryCache, RequestCache};
pub use events::{BusMessage, DynEventBus, EventBus, RecordingEventBus};
pub use files::{
    ByteRange, DynFileStore, FileStore, FileStores, MemoryFileStore, ObjectInfo, PutOptions,
    RangedObject, StorageBuckets, Stored, StoredObject, get_stored, is_safe_key, unsafe_key,
};
pub use flags::{DefaultFlags, DynFlagSource, FlagContext, FlagSource, FlagSourceExt, StaticFlags};
pub use identity::{
    Identity, IdentityCall, IdentityError, IdentityProvider, IdentityResult, Invitation, ListPage,
    Listing, MemberUser, Membership, MemoryIdentity, NewInvitation, NewMembership, Organization,
    OrganizationChanges, OrganizationRef, User, UserProfile, with_identity,
};
pub use in_process_jobs::InProcessJobs;
pub use jobs::{
    DynJobs, Job, JobContext, JobError, JobRegistry, JobRequest, Jobs, NoopJob, StepFn, StepRetry,
    step,
};
pub use ledger_store::{LedgerChanges, LedgerSnapshot, LedgerStore, MemoryLedgerStore};
pub use mail::{
    DynSystemMail, MailAttachment, Mailbox, OutgoingMail, RecordingSystemMail, SentMail, SystemMail,
};
pub use outbound::{DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp};
pub use presence::{DynPresence, PresenceReader};
pub use realtime::{
    DynRealtimePublisher, RealtimeMessage, RealtimePublisher, RecordingRealtime, Room,
};
pub use transport::{
    Envelope, MailTransport, RecordingMailTransport, SentEnvelope, TransportFailure,
};

/// A boxed, sendable future: what the `Dyn*` port traits return.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Why a port call failed. Adapters wrap their client's error; callers mostly
/// log it, since every side effect behind a port is best effort for the
/// request that caused it.
#[derive(Debug)]
pub enum PortError {
    /// A value could not be turned into JSON or back.
    Json(serde_json::Error),
    /// The backing service refused or could not be reached.
    Backend(Box<dyn std::error::Error + Send + Sync>),
}

impl PortError {
    /// Wraps any adapter error.
    pub fn backend(error: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        Self::Backend(error.into())
    }
}

impl fmt::Display for PortError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(f, "json: {error}"),
            Self::Backend(error) => write!(f, "backend: {error}"),
        }
    }
}

impl std::error::Error for PortError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            Self::Backend(error) => Some(error.as_ref()),
        }
    }
}

impl From<serde_json::Error> for PortError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}
