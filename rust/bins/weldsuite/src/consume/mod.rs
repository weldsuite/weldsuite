//! `weldsuite consume`: the entity-event hub subscribers on NATS `JetStream`
//! (P4 4f; EVT-001 on Kubernetes). The Kubernetes counterpart of
//! entity-events-worker and the queue consumers it fans out to.
//!
//! Stream layout:
//!
//! - **Hub** `ENTITY_EVENTS` (`entity-events.<entityType>.<action>`), which
//!   `serve` publishes to: limits retention, seven days, a two-minute
//!   duplicate window on `Nats-Msg-Id` = the event id. Every subscriber is a
//!   durable pull consumer on it named by its registry id (`audit`,
//!   `search-index`, `webhooks`, `realtime`), so the stream itself is the
//!   fan-out.
//! - **Dead letters** `ENTITY_EVENTS_DLQ` (`entity-events-dlq.<subscriber>.
//!   <entityType>.<action>`), fourteen days: a message a subscriber failed on
//!   `max_retries + 1` times, with headers naming the subscriber, the hub
//!   sequence, the deliveries and the last error.
//!
//! The subscribers not ported (analytics, WeldConnect, WeldAgent) have no
//! consumer, so nothing waits for them: their events age out of the hub with
//! everything else after seven days.
//!
//! The process serves `/livez`, `/readyz` (master database and NATS answer,
//! not draining) and `/health` on `PORT`. On SIGTERM it stops fetching,
//! finishes the batches in hand within `CONSUME_DRAIN_SECONDS` and exits.

mod config;

use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::json;
use tokio::sync::watch;
use weldsuite_adapters_oss::{
    ConsumerSpec, JetStreamEventBus, NatsOptions, OpenAiEmbeddings, OpenAiEmbeddingsOptions,
    ValkeyRealtime, connect_valkey, dead_letter_stream_config, ensure_consumer,
    entity_events_stream_config, run_consumer,
};
use weldsuite_db::{PgPool, Workspaces, master_pool};
use weldsuite_ports::{BatchHandler, DynRealtimePublisher, Embeddings};
use weldsuite_subscribers::audit::LOCKED_MAX_RETRIES;
use weldsuite_subscribers::{
    AuditSubscriber, RealtimeSubscriber, Routed, SearchSubscriber, Subscriber, Tenants,
    WebhookHttp, WebhooksSubscriber, WorkspaceTenants, filter_subject, run_webhook_retry_sweep,
    subscriber,
};

pub(crate) use config::ConsumeConfig;

type Error = Box<dyn std::error::Error>;

/// Pause before retry 1, 2 and 3 of a failed delivery (the queues retried
/// at once; a short backoff spares a sink that is briefly down).
const RETRY_BACKOFF: [Duration; 3] = [
    Duration::from_secs(5),
    Duration::from_secs(30),
    Duration::from_secs(120),
];

/// Completed event ids each consumer remembers (EVT-002 dedupe).
const DEDUPE_CAPACITY: usize = 10_000;

/// The advisory lock that lets one `consume` pod at a time run the webhook
/// retry sweep ("WELDWRTY").
const WEBHOOK_SWEEP_LOCK: i64 = 0x5745_4c44_5752_5459;

/// Entry point of `weldsuite consume`.
pub(crate) fn run() -> ExitCode {
    let config = match ConsumeConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(78); // EX_CONFIG
        }
    };
    let telemetry = crate::telemetry::init(config.log_format, "info");
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "cannot start the async runtime");
            return ExitCode::FAILURE;
        }
    };
    let code = match runtime.block_on(consume(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "consume stopped");
            ExitCode::FAILURE
        }
    };
    telemetry.shutdown();
    code
}

/// How a subscriber consumes the hub, from its registry row.
pub(crate) fn consumer_spec(sub: &Subscriber, config: &ConsumeConfig) -> ConsumerSpec {
    let ack_wait = match sub.id {
        "search-index" | "webhooks" => Duration::from_secs(120),
        _ => Duration::from_secs(60),
    };
    ConsumerSpec {
        stream: config.stream.clone(),
        durable: sub.id.to_owned(),
        description: format!(
            "WeldSuite {} subscriber (the {} queue in Global)",
            sub.id, sub.queue
        ),
        filter_subject: filter_subject(sub.topics, &config.subject_prefix),
        deliver_new_only: sub.id == "realtime",
        max_retries: sub.max_retries,
        max_deferrals: if sub.id == "audit" {
            LOCKED_MAX_RETRIES
        } else {
            0
        },
        retry_backoff: RETRY_BACKOFF.to_vec(),
        ack_wait,
        batch_size: sub.batch_size,
        batch_wait: Duration::from_secs(sub.batch_timeout_seconds),
        workers: sub.concurrency,
        dead_letter_subject: format!("{}-dlq.{}", config.subject_prefix, sub.id),
        dedupe_capacity: DEDUPE_CAPACITY,
    }
}

/// What the probes look at.
#[derive(Clone)]
struct Probe {
    workspaces: Arc<Workspaces>,
    bus: JetStreamEventBus,
    draining: Arc<AtomicBool>,
    environment: String,
    subscribers: Arc<Vec<String>>,
}

fn probes(probe: Probe) -> Router {
    Router::new()
        .route("/livez", get(|| async { "ok" }))
        .route("/readyz", get(readyz))
        .route("/health", get(health))
        .with_state(probe)
}

async fn readyz(State(probe): State<Probe>) -> Response {
    if probe.draining.load(Ordering::Relaxed) {
        return (StatusCode::SERVICE_UNAVAILABLE, "draining").into_response();
    }
    if !probe.bus.is_connected() {
        return (StatusCode::SERVICE_UNAVAILABLE, "nats unavailable").into_response();
    }
    match tokio::time::timeout(Duration::from_secs(2), probe.workspaces.ping_master()).await {
        Ok(Ok(())) => "ok".into_response(),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "master database unavailable",
        )
            .into_response(),
    }
}

async fn health(State(probe): State<Probe>) -> Response {
    let master = matches!(
        tokio::time::timeout(Duration::from_secs(3), probe.workspaces.ping_master()).await,
        Ok(Ok(()))
    );
    let nats = probe.bus.is_connected();
    let ok = master && nats;
    let body = json!({
        "status": if ok { "pass" } else { "fail" },
        "service": "weldsuite-consume",
        "environment": probe.environment,
        "timestamp": weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc()),
        "subscribers": *probe.subscribers,
        "checks": {
            "masterDb": if master { "pass" } else { "fail" },
            "nats": if nats { "pass" } else { "fail" },
        },
    });
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, axum::Json(body)).into_response()
}

/// The handlers to run, by subscriber id; a subscriber whose service is not
/// configured is left out with a warning.
fn handlers(
    config: &ConsumeConfig,
    tenants: &Arc<dyn Tenants>,
    master: &PgPool,
    realtime: Option<&Arc<dyn DynRealtimePublisher>>,
    embeddings: Option<&Arc<dyn Embeddings>>,
    http: &WebhookHttp,
) -> Vec<(&'static Subscriber, Arc<dyn BatchHandler>)> {
    let mut out: Vec<(&'static Subscriber, Arc<dyn BatchHandler>)> = Vec::new();
    for id in &config.subscribers {
        let Some(sub) = subscriber(id) else { continue };
        let handler: Arc<dyn BatchHandler> = match id.as_str() {
            "audit" => Arc::new(AuditSubscriber::new(Arc::clone(tenants))),
            "webhooks" => Arc::new(WebhooksSubscriber::new(
                Arc::clone(tenants),
                Some(master.clone()),
                http.clone(),
            )),
            "realtime" => {
                let Some(realtime) = realtime else {
                    tracing::warn!("VALKEY_URL is not set: the realtime subscriber does not run");
                    continue;
                };
                Arc::new(RealtimeSubscriber::new(
                    Arc::clone(tenants),
                    Arc::clone(realtime),
                ))
            }
            "search-index" => {
                let Some(embeddings) = embeddings else {
                    tracing::warn!(
                        "EMBEDDINGS_URL is not set: the search-index subscriber does not run"
                    );
                    continue;
                };
                Arc::new(SearchSubscriber::new(
                    Arc::clone(tenants),
                    Arc::clone(embeddings),
                ))
            }
            _ => continue,
        };
        out.push((sub, Arc::new(Routed::new(sub.topics, handler))));
    }
    out
}

/// What the subscribers talk to besides the databases.
struct Services {
    bus: JetStreamEventBus,
    realtime: Option<Arc<dyn DynRealtimePublisher>>,
    embeddings: Option<Arc<dyn Embeddings>>,
    http: WebhookHttp,
}

/// Connects NATS (creating the streams when asked) and Valkey, and builds
/// the embeddings and webhook clients. A configured service that can't be
/// reached fails the start, so a broken pod crash-loops visibly.
async fn connect(config: &ConsumeConfig) -> Result<Services, Error> {
    let bus = JetStreamEventBus::connect(&NatsOptions {
        url: config.nats_url.clone(),
        user: config.nats_user.clone(),
        token: config.nats_token.clone(),
        name: Some("weldsuite-consume".to_owned()),
    })
    .await?;
    if config.ensure_streams {
        // Create or update: `serve` may have created the hub first with one
        // replica and no cap (its `ensure_stream` leaves an existing stream
        // alone); this brings it to the configured count and size. A full
        // stream drops its oldest messages, as its age limit does.
        let mut hub = entity_events_stream_config(&config.stream, &config.subject_prefix);
        hub.num_replicas = config.stream_replicas;
        hub.max_bytes = config.stream_max_bytes.unwrap_or(-1);
        bus.context().create_or_update_stream(hub).await?;
        let mut dead_letters = dead_letter_stream_config(
            &config.dead_letter_stream,
            &format!("{}-dlq", config.subject_prefix),
            config.stream_replicas,
        );
        dead_letters.max_bytes = config.dead_letter_max_bytes.unwrap_or(-1);
        bus.context().create_or_update_stream(dead_letters).await?;
    }
    let realtime: Option<Arc<dyn DynRealtimePublisher>> = match &config.valkey_url {
        Some(url) => Some(Arc::new(ValkeyRealtime::new(
            connect_valkey(url).await?,
            config.valkey_realtime_prefix.clone(),
        ))),
        None => None,
    };
    let embeddings: Option<Arc<dyn Embeddings>> = match &config.embeddings {
        Some(settings) => Some(Arc::new(OpenAiEmbeddings::new(OpenAiEmbeddingsOptions {
            base_url: settings.url.clone(),
            model: settings.model.clone(),
            api_key: settings.api_key.clone(),
        })?)),
        None => None,
    };
    Ok(Services {
        bus,
        realtime,
        embeddings,
        http: WebhookHttp::new(config.webhook_allow_private)?,
    })
}

async fn consume(config: ConsumeConfig) -> Result<(), Error> {
    tracing::info!(
        ?config,
        version = env!("CARGO_PKG_VERSION"),
        "consume: starting"
    );
    let master = master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        config.keyring.clone(),
        config.workspaces.clone(),
    ));
    let tenants: Arc<dyn Tenants> = Arc::new(WorkspaceTenants::new(Arc::clone(&workspaces)));
    let Services {
        bus,
        realtime,
        embeddings,
        http,
    } = connect(&config).await?;

    let running = handlers(
        &config,
        &tenants,
        &master,
        realtime.as_ref(),
        embeddings.as_ref(),
        &http,
    );
    let (stop, stopping) = watch::channel(false);
    let mut tasks = Vec::new();
    let mut names = Vec::new();
    for (sub, handler) in running {
        let spec = consumer_spec(sub, &config);
        let consumer = ensure_consumer(bus.context(), &spec).await?;
        tracing::info!(
            consumer = spec.durable,
            filter = spec.filter_subject,
            max_deliver = spec.max_deliver(),
            workers = spec.workers,
            "consume: consuming"
        );
        names.push(sub.id.to_owned());
        tasks.push(tokio::spawn(run_consumer(
            bus.context().clone(),
            consumer,
            Arc::new(spec),
            handler,
            stopping.clone(),
        )));
    }
    if names.iter().any(|name| name == "webhooks") && config.webhook_retry_sweep {
        tasks.push(tokio::spawn(webhook_retry_sweeps(
            master.clone(),
            Arc::clone(&tenants),
            http.clone(),
            stopping.clone(),
        )));
    }

    let draining = Arc::new(AtomicBool::new(false));
    let probe = Probe {
        workspaces,
        bus: bus.clone(),
        draining: Arc::clone(&draining),
        environment: config.environment.clone(),
        subscribers: Arc::new(names),
    };
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!(listen = %config.listen, "consume: serving probes");
    let mut probe_stop = stopping.clone();
    let probes = tokio::spawn(async move {
        let _ = axum::serve(listener, probes(probe))
            .with_graceful_shutdown(async move {
                let _ = probe_stop.wait_for(|stopping| *stopping).await;
            })
            .await;
    });

    crate::server::shutdown_signal(Arc::clone(&draining), Duration::ZERO).await;
    let _ = stop.send(true);
    let deadline = tokio::time::Instant::now() + config.drain;
    let started = Instant::now();
    for task in tasks {
        if tokio::time::timeout_at(deadline, task).await.is_err() {
            tracing::warn!(
                "consume: batches still in hand at the drain deadline; the server redelivers them"
            );
            break;
        }
    }
    let _ = probes.await;
    tracing::info!(
        drained_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "consume: stopped"
    );
    Ok(())
}

/// Every ten minutes (and at start), the webhook retry sweep, by one pod at
/// a time: the integration-webhook-worker's cron, until the cron role exists.
async fn webhook_retry_sweeps(
    master: PgPool,
    tenants: Arc<dyn Tenants>,
    http: WebhookHttp,
    mut stop: watch::Receiver<bool>,
) {
    let mut ticker = tokio::time::interval(weldsuite_subscribers::webhooks::WEBHOOK_RETRY_INTERVAL);
    loop {
        tokio::select! {
            _ = ticker.tick() => {},
            _ = stop.wait_for(|stopping| *stopping) => return,
        }
        if let Err(error) = sweep_once(&master, &*tenants, &http).await {
            tracing::warn!(%error, "webhooks: retry sweep skipped");
        }
    }
}

async fn sweep_once(
    master: &PgPool,
    tenants: &dyn Tenants,
    http: &WebhookHttp,
) -> Result<(), sqlx::Error> {
    let mut lock = master.begin().await?;
    let mine: bool = sqlx::query_scalar("select pg_try_advisory_xact_lock($1)")
        .bind(WEBHOOK_SWEEP_LOCK)
        .fetch_one(&mut *lock)
        .await?;
    if mine {
        run_webhook_retry_sweep(master, tenants, http).await;
    }
    lock.commit().await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use weldsuite_subscribers::SUBSCRIBERS;

    use super::*;

    fn config() -> ConsumeConfig {
        let vars: HashMap<&str, &str> = HashMap::from([
            ("DATABASE_URL_MASTER", "postgres://master"),
            ("NATS_URL", "nats://nats:4222"),
        ]);
        ConsumeConfig::from_lookup(|name| vars.get(name).map(|v| (*v).to_owned())).expect("valid")
    }

    #[test]
    fn specs_follow_the_queues() {
        let config = config();
        let audit = consumer_spec(subscriber("audit").expect("audit"), &config);
        assert_eq!(audit.filter_subject, "entity-events.>");
        assert_eq!(audit.max_deliver(), 24);
        assert_eq!(audit.dead_letter_subject, "entity-events-dlq.audit");
        assert!(!audit.deliver_new_only);
        let realtime = consumer_spec(subscriber("realtime").expect("realtime"), &config);
        assert_eq!(realtime.max_deliver(), 4);
        assert!(realtime.deliver_new_only);
        let search = consumer_spec(subscriber("search-index").expect("search"), &config);
        assert_eq!((search.batch_size, search.workers), (25, 4));
    }

    #[test]
    fn only_ported_subscribers_have_consumers() {
        let ported: Vec<&str> = SUBSCRIBERS
            .iter()
            .filter(|sub| sub.ported)
            .map(|sub| sub.id)
            .collect();
        let mut expected = config::PORTED.to_vec();
        expected.sort_unstable();
        let mut ported_sorted = ported.clone();
        ported_sorted.sort_unstable();
        assert_eq!(ported_sorted, expected);
    }
}
