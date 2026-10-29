//! The services behind the ports, connected at start from [`InfraConfig`]:
//! Valkey for cache and realtime, NATS `JetStream` for entity events, the
//! master database (or the catalog defaults) for feature flags. A service that
//! isn't configured is left out, and what it carries is skipped with a
//! warning, as the workers behave without the binding.
//!
//! Conformance builds never connect: they record instead
//! (`conformance::infra`).

#![cfg_attr(feature = "conformance", allow(dead_code))]

use std::sync::Arc;

use weldsuite_adapters_oss::{
    JetStreamEventBus, MasterDbFlagSource, NatsOptions, ValkeyCache, ValkeyRealtime,
    connect_valkey, entity_events_stream_config,
};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_ports::{DefaultFlags, DynCache, DynEventBus, DynFlagSource, DynRealtimePublisher};

use crate::config::{FlagSourceKind, InfraConfig};

type Error = Box<dyn std::error::Error>;

/// What the handlers publish and read through.
#[derive(Clone)]
pub(crate) struct Infra {
    pub(crate) events: EntityEventPublisher,
    pub(crate) realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// Not read by a ported route yet; know-api (P3) is the first.
    pub(crate) cache: Option<Arc<dyn DynCache>>,
    pub(crate) flags: Arc<dyn DynFlagSource>,
}

impl std::fmt::Debug for Infra {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Infra")
            .field("events", &self.events)
            .field("realtime", &self.realtime.is_some())
            .field("cache", &self.cache.is_some())
            .finish_non_exhaustive()
    }
}

impl Infra {
    /// Nothing connected: events and realtime skipped, flags at their
    /// defaults. For tests.
    #[cfg(test)]
    pub(crate) fn disconnected(tracker: TaskTracker) -> Self {
        Self {
            events: EntityEventPublisher::new(None, tracker),
            realtime: None,
            cache: None,
            flags: Arc::new(DefaultFlags),
        }
    }
}

/// Valkey's cache and realtime publisher, sharing one connection.
struct Valkey {
    cache: Arc<dyn DynCache>,
    realtime: Arc<dyn DynRealtimePublisher>,
}

async fn valkey(config: &InfraConfig) -> Result<Option<Valkey>, Error> {
    let Some(url) = &config.valkey_url else {
        tracing::warn!("VALKEY_URL is not set: no cache, realtime publishes are skipped");
        return Ok(None);
    };
    let connection = connect_valkey(url).await?;
    Ok(Some(Valkey {
        cache: Arc::new(ValkeyCache::new(
            connection.clone(),
            config.valkey_cache_prefix.clone(),
        )),
        realtime: Arc::new(ValkeyRealtime::new(
            connection,
            config.valkey_realtime_prefix.clone(),
        )),
    }))
}

async fn event_bus(config: &InfraConfig) -> Result<Option<Arc<dyn DynEventBus>>, Error> {
    let Some(url) = &config.nats_url else {
        tracing::warn!("NATS_URL is not set: entity events are skipped");
        return Ok(None);
    };
    let bus = JetStreamEventBus::connect(&NatsOptions {
        url: url.clone(),
        user: config.nats_user.clone(),
        token: config.nats_token.clone(),
        name: Some("weldsuite".to_owned()),
    })
    .await?;
    if config.nats_ensure_streams {
        bus.ensure_stream(entity_events_stream_config(
            &config.nats_stream,
            &config.nats_subject_prefix,
        ))
        .await?;
    }
    Ok(Some(Arc::new(bus)))
}

/// Connect what `config` names. Fails when a configured service can't be
/// reached at start, so a misconfigured pod crash-loops visibly instead of
/// dropping events.
pub(crate) async fn connect(
    config: &InfraConfig,
    master: &PgPool,
    tracker: TaskTracker,
) -> Result<Infra, Error> {
    let valkey = valkey(config).await?;
    let bus = event_bus(config).await?;
    let flags: Arc<dyn DynFlagSource> = match config.flags {
        FlagSourceKind::Defaults => Arc::new(DefaultFlags),
        FlagSourceKind::MasterDb => Arc::new(MasterDbFlagSource::new(
            master.clone(),
            config.flags_refresh,
        )),
    };
    let (cache, realtime) = valkey.map_or((None, None), |v| (Some(v.cache), Some(v.realtime)));
    Ok(Infra {
        events: EntityEventPublisher::new(bus, tracker)
            .with_subject_prefix(&config.nats_subject_prefix),
        realtime,
        cache,
        flags,
    })
}
