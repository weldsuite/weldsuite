//! The services behind the ports, connected at start from [`InfraConfig`]:
//! Valkey for cache and realtime, NATS `JetStream` for entity events, the
//! master database (or the catalog defaults) for feature flags, S3 for files. A service that
//! isn't configured is left out, and what it carries is skipped with a
//! warning, as the workers behave without the binding.
//!
//! Conformance builds never connect: they record instead
//! (`conformance::infra`).

#![cfg_attr(feature = "conformance", allow(dead_code))]

use std::sync::Arc;

use weldsuite_adapters_oss::{
    JetStreamEventBus, MasterDbFlagSource, NatsOptions, S3FileStore, ValkeyCache, ValkeyRealtime,
    connect_valkey, entity_events_stream_config,
};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_ports::{
    DefaultFlags, DynCache, DynEventBus, DynFileStore, DynFlagSource, DynJobs,
    DynRealtimePublisher, InProcessJobs, JobRegistry, NoopJob,
};

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
    /// The private bucket (the workers' `PRIVATE_STORAGE`). Not read by a
    /// ported route yet; sign (P3) is the first.
    pub(crate) files: Option<Arc<dyn DynFileStore>>,
    /// The legacy public bucket (`STORAGE`), read only, for objects stored
    /// before the private one existed (`get_stored`).
    pub(crate) public_files: Option<Arc<dyn DynFileStore>>,
    /// Starts durable jobs (the workers' Workflows): Restate, or in process.
    #[allow(dead_code, reason = "sign's finalize job (P3) is the first caller")]
    pub(crate) jobs: Arc<dyn DynJobs>,
    /// The jobs this process runs; modules register theirs once their state
    /// exists. `weldsuite.noop` is always there, for the smoke test.
    pub(crate) job_registry: JobRegistry,
}

impl std::fmt::Debug for Infra {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Infra")
            .field("events", &self.events)
            .field("realtime", &self.realtime.is_some())
            .field("cache", &self.cache.is_some())
            .field("files", &self.files.is_some())
            .field("public_files", &self.public_files.is_some())
            .field("job_registry", &self.job_registry)
            .finish_non_exhaustive()
    }
}

impl Infra {
    /// Nothing connected: events and realtime skipped, flags at their
    /// defaults. For tests.
    #[cfg(test)]
    pub(crate) fn disconnected(tracker: TaskTracker) -> Self {
        let job_registry = job_registry();
        Self {
            jobs: Arc::new(InProcessJobs::new(job_registry.clone(), tracker.clone())),
            job_registry,
            events: EntityEventPublisher::new(None, tracker),
            realtime: None,
            cache: None,
            files: None,
            public_files: None,
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

/// The private and public file stores. Nothing is sent until a route uses
/// one, so a wrong key shows up in that route's logs, not at start.
type FileStores = (Option<Arc<dyn DynFileStore>>, Option<Arc<dyn DynFileStore>>);

fn file_stores(config: &InfraConfig) -> Result<FileStores, Error> {
    let Some(files) = &config.files else {
        tracing::warn!("S3_ENDPOINT is not set: no file storage, file routes will fail");
        return Ok((None, None));
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let private: Arc<dyn DynFileStore> =
        Arc::new(S3FileStore::new(&files.private, client.clone())?);
    let public = match files.public() {
        Some(options) => {
            Some(Arc::new(S3FileStore::new(&options, client)?) as Arc<dyn DynFileStore>)
        }
        None => None,
    };
    Ok((Some(private), public))
}

/// The registry every process starts with.
pub(crate) fn job_registry() -> JobRegistry {
    let registry = JobRegistry::new();
    registry.register(NoopJob);
    registry
}

/// Restate when configured, else jobs run as tasks in this process.
fn jobs(
    config: &InfraConfig,
    registry: &JobRegistry,
    tracker: &TaskTracker,
) -> Result<Arc<dyn DynJobs>, Error> {
    let Some(ingress) = &config.jobs.restate_ingress_url else {
        tracing::warn!(
            "RESTATE_INGRESS_URL is not set: jobs run in this process and a restart loses them"
        );
        return Ok(Arc::new(InProcessJobs::new(
            registry.clone(),
            tracker.clone(),
        )));
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    Ok(Arc::new(weldsuite_adapters_oss::RestateJobs::new(
        ingress, client,
    )))
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
    let (files, public_files) = file_stores(config)?;
    let job_registry = job_registry();
    let jobs = jobs(config, &job_registry, &tracker)?;
    Ok(Infra {
        jobs,
        job_registry,
        events: EntityEventPublisher::new(bus, tracker)
            .with_subject_prefix(&config.nats_subject_prefix),
        realtime,
        cache,
        flags,
        files,
        public_files,
    })
}
