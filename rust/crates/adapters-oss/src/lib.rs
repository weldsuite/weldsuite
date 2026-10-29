//! Open-source adapters for the ports of `weldsuite-ports`, for the
//! Kubernetes editions (EU and self-hosted), where the Cloudflare bindings the
//! workers use do not exist.
//!
//! | Port | Adapter | Replaces |
//! |---|---|---|
//! | `Cache` | [`ValkeyCache`] | KV `WORKSPACE_CACHE` |
//! | `RealtimePublisher` | [`ValkeyRealtime`] (pub/sub; [`realtime::ValkeyBackplane`] is the WebSocket gateway's side) | realtime-worker `/publish/*` over `REALTIME`, and its Durable Objects' state |
//! | `EventBus` | [`JetStreamEventBus`] | Queue `ENTITY_EVENTS` |
//! | `FlagSource` | [`MasterDbFlagSource`] | Cloudflare Flagship `FLAGSHIP` |
//! | `FileStore` | [`S3FileStore`] (MinIO, Garage, Ceph RGW, Hetzner, AWS) | R2 `PRIVATE_STORAGE`, `STORAGE` |
//! | `Jobs` | [`RestateJobs`], with [`serve_endpoint`] and [`register_deployment`] | Cloudflare Workflows |
//! | `SystemMail` | [`SmtpMail`] (any SMTP relay) | Email Service `SEND_EMAIL` |
//! | `Identity` | [`ZitadelIdentity`] | Clerk's Backend API |
//!
//! Adapters take their settings as arguments; the server reads them from the
//! environment.

mod flags;
mod nats;
pub mod realtime;
mod restate;
mod s3;
mod smtp;
mod valkey;
mod zitadel;

pub use flags::{DEFAULT_FLAG_REFRESH, MasterDbFlagSource};
pub use nats::{
    DEFAULT_ENTITY_EVENTS_STREAM, JetStreamEventBus, NatsOptions, entity_events_stream_config,
};
pub use restate::{
    JOBS_SERVICE, JobCall, RestateJobs, WeldsuiteJobs, register_deployment, serve_endpoint,
};
pub use s3::{S3FileStore, S3Options};
pub use smtp::SmtpMail;
pub use valkey::{ValkeyCache, ValkeyRealtime, connect_valkey};
pub use zitadel::{ZitadelIdentity, ZitadelOptions};
