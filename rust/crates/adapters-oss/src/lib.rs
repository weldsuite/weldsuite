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
//! | `MailTransport` | [`SmtpMailTransport`] (customer mail, its own relay identity, MAIL-010) | `SEND_EMAIL` for user-written mail |
//! | `LedgerStore` | [`ValkeyLedgerStore`] (one Lua script per commit) | the `OutboundLedger` / `OutboundPlatformBudget` Durable Objects |
//! | `Identity` | [`ZitadelIdentity`] | Clerk's Backend API |
//! | `OutboundHttp` | [`ReqwestOutbound`] | a Worker's `fetch` to third parties |
//! | `DatabaseProvisioner` | [`CnpgProvisioner`] (CloudNativePG shards behind `PgBouncer`) | Neon provisioning |
//! | `BatchHandler` (consuming) | [`run_consumer`] on a durable `JetStream` consumer | Queue consumers of the hub subscribers |
//! | `Embeddings` | [`OpenAiEmbeddings`] (any OpenAI-compatible endpoint) | Workers AI through the AI Gateway |
//!
//! Adapters take their settings as arguments; the server reads them from the
//! environment.

mod cnpg;
mod embeddings;
mod flags;
mod http;
mod nats;
mod nats_consume;
pub mod realtime;
mod restate;
mod s3;
mod smtp;
mod smtp_transport;
mod valkey;
mod valkey_ledger;
mod zitadel;

pub use cnpg::{CnpgOptions, CnpgProvisioner, CnpgShard, database_names};
pub use embeddings::{OpenAiEmbeddings, OpenAiEmbeddingsOptions};
pub use flags::{DEFAULT_FLAG_REFRESH, MasterDbFlagSource};
pub use http::ReqwestOutbound;
pub use nats::{
    DEFAULT_ENTITY_EVENTS_STREAM, JetStreamEventBus, NatsOptions, entity_events_stream_config,
};
pub use nats_consume::{
    Action, ConsumerSpec, dead_letter_stream_config, dead_letter_subject, decide, ensure_consumer,
    run_consumer,
};
pub use restate::{
    JOBS_SERVICE, JobCall, RestateJobs, SIGNALS_OBJECT, WeldsuiteJobSignals, WeldsuiteJobs,
    register_deployment, serve_endpoint,
};
pub use s3::{S3FileStore, S3Options};
pub use smtp::SmtpMail;
pub use smtp_transport::{SmtpMailTransport, refusal_code};
pub use valkey::{ValkeyCache, ValkeyRealtime, connect_valkey};
pub use valkey_ledger::ValkeyLedgerStore;
pub use zitadel::{ZitadelIdentity, ZitadelOptions};
