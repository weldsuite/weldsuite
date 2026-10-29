//! Open-source adapters for the ports of `weldsuite-ports`, for the
//! Kubernetes editions (EU and self-hosted), where the Cloudflare bindings the
//! workers use do not exist.
//!
//! | Port | Adapter | Replaces |
//! |---|---|---|
//! | `Cache` | [`ValkeyCache`] | KV `WORKSPACE_CACHE` |
//! | `RealtimePublisher` | [`ValkeyRealtime`] (pub/sub) | realtime-worker `/publish/*` over `REALTIME` |
//! | `EventBus` | [`JetStreamEventBus`] | Queue `ENTITY_EVENTS` |
//! | `FlagSource` | [`MasterDbFlagSource`] | Cloudflare Flagship `FLAGSHIP` |
//!
//! Adapters take their settings as arguments; the server reads them from the
//! environment.

mod flags;
mod nats;
mod valkey;

pub use flags::{DEFAULT_FLAG_REFRESH, MasterDbFlagSource};
pub use nats::{
    DEFAULT_ENTITY_EVENTS_STREAM, JetStreamEventBus, NatsOptions, entity_events_stream_config,
};
pub use valkey::{ValkeyCache, ValkeyRealtime, connect_valkey};
