//! `weldsuite mta run`: one process per mail node. It migrates the
//! database, works out its public IPv4 and EHLO name, then runs until
//! SIGTERM:
//!
//! - the submission listener (private address, 2587),
//! - the bounce MX (port 25) when `MTA_INBOUND_ADDR` is set,
//! - the HTTP API (private address, 8025),
//! - the delivery workers for `MTA_POOLS`,
//! - the outbox publisher (with NATS), the TLS-RPT reporter (with a bounce
//!   domain) and housekeeping.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::{TcpListener, UdpSocket};
use tokio_util::sync::CancellationToken;

use crate::api::{ApiState, router};
use crate::config::{Config, NatsSettings};
use crate::delivery::Delivery;
use crate::dns::Resolver;
use crate::domains::Signers;
use crate::inbound::BounceMx;
use crate::mta_sts::Sts;
use crate::shaping::Shaper;
use crate::smtp::client::{ClientSettings, TlsConfigs};
use crate::smtp::server;
use crate::store::Store;
use crate::submission::Submission;
use crate::tls::Reloading;
use crate::tlsrpt::Reporter;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// The address outbound traffic leaves from: the local end of a UDP
/// "connection" to a public address (no packet is sent). `None` when that
/// is a private address (NAT: binding would not help).
async fn detect_source_ip() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    socket.connect("192.0.2.1:25").await.ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() => Some(ip),
        _ => None,
    }
}

/// The EHLO name: `MTA_HOSTNAME`, else the source IP's PTR name, checked
/// forward (its A records include the IP), as receivers check it.
async fn hostname(
    config: &Config,
    resolver: &Resolver,
    ip: Option<Ipv4Addr>,
) -> Result<String, BoxError> {
    if let Some(name) = &config.hostname {
        return Ok(name.clone());
    }
    let ip = ip.ok_or("MTA_HOSTNAME is required when the public IPv4 cannot be detected")?;
    let name = resolver
        .ptr(ip)
        .await?
        .ok_or_else(|| format!("{ip} has no reverse DNS: set its PTR record (or MTA_HOSTNAME)"))?;
    let forward = resolver.ipv4(&name).await.unwrap_or_default();
    if !forward.contains(&ip) {
        tracing::warn!(%ip, %name, "the PTR name does not resolve back to the IP; receivers will distrust this sender");
    }
    Ok(name)
}

async fn connect_nats(settings: &NatsSettings) -> Result<async_nats::jetstream::Context, BoxError> {
    let options = match (&settings.user, &settings.token) {
        (Some((user, password)), _) => {
            async_nats::ConnectOptions::with_user_and_password(user.clone(), password.clone())
        }
        (None, Some(token)) => async_nats::ConnectOptions::with_token(token.clone()),
        (None, None) => async_nats::ConnectOptions::new(),
    }
    .name("weldsuite-mta")
    .connection_timeout(Duration::from_secs(5));
    let servers: Vec<&str> = settings.url.split(',').map(str::trim).collect();
    let client = options.connect(servers.as_slice()).await?;
    Ok(async_nats::jetstream::new(client))
}

fn tls(pair: Option<&(String, String)>) -> Result<Option<Arc<Reloading>>, BoxError> {
    Ok(match pair {
        Some((cert, key)) => Some(Arc::new(Reloading::new(cert, key)?)),
        None => None,
    })
}

/// Serves the HTTP API until `shutdown` is cancelled.
async fn serve_api(listener: TcpListener, api: axum::Router, shutdown: CancellationToken) {
    let served = axum::serve(listener, api)
        .with_graceful_shutdown(async move { shutdown.cancelled().await })
        .await;
    if let Err(error) = served {
        tracing::error!(%error, "API stopped");
    }
}

/// The delivery workers for `MTA_POOLS`, sending as `hostname`.
fn delivery(
    config: &Config,
    store: &Store,
    resolver: &Arc<Resolver>,
    signers: &Arc<Signers>,
    hostname: &str,
    source_ip: Option<Ipv4Addr>,
) -> Result<Arc<Delivery>, BoxError> {
    Ok(Arc::new(Delivery {
        store: store.clone(),
        keys: config.base.keys.clone(),
        resolver: Arc::clone(resolver),
        sts: Arc::new(Sts::new(Arc::clone(resolver))?),
        shaper: Arc::new(Shaper::new()),
        signers: Arc::clone(signers),
        client: ClientSettings {
            helo: hostname.to_owned(),
            source_ip,
            port: config.delivery_port,
            tls: TlsConfigs::new()?,
        },
        pools: config.pools.clone(),
        owner: format!("{hostname}:{}", std::process::id()),
        bounce_domain: config.bounce_domain.clone(),
        max_queue_age: config.max_queue_age,
        warmup: config.warmup_schedule.clone(),
        concurrency: config.concurrency,
        allow_private_destinations: config.allow_private_destinations,
    }))
}

/// Housekeeping every ten minutes until `shutdown` is cancelled.
async fn housekeeping(store: Store, shutdown: CancellationToken) {
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = tokio::time::sleep(Duration::from_secs(600)) => {}
        }
        if let Err(error) = store.housekeep().await {
            tracing::warn!(%error, "housekeeping failed");
        }
    }
}

/// Runs the MTA until `shutdown` is cancelled.
pub async fn run(config: Config, shutdown: CancellationToken) -> Result<(), BoxError> {
    let store =
        Store::connect(&config.base.database_url, 16)?.with_suppress_days(config.suppress_days);
    let migrated = store.migrate().await?;
    tracing::info!(migrated, "MTA database ready");

    let resolver = Arc::new(config.resolver.map_or_else(Resolver::system, Resolver::new));
    let source_ip = match config.source_ip {
        Some(ip) => Some(ip),
        None => detect_source_ip().await,
    };
    let hostname = hostname(&config, &resolver, source_ip).await?;
    tracing::info!(%hostname, source = ?source_ip, pools = ?config.pools, resolver = %resolver.server(), "MTA starting");

    let keys = config.base.keys.clone();
    let signers = Arc::new(Signers::new(store.clone(), keys.clone()));
    let mut tasks = tokio::task::JoinSet::new();

    // Submission.
    let submission = Arc::new(Submission {
        hostname: hostname.clone(),
        max_message_bytes: config.max_message_bytes,
        tls: tls(config.submission_tls.as_ref())?,
        passwords: config.pool_passwords.clone(),
        store: store.clone(),
        signers: Arc::clone(&signers),
    });
    let listener = TcpListener::bind(config.submission_addr).await?;
    tracing::info!(addr = %config.submission_addr, "submission listening");
    tasks.spawn(server::listen(listener, submission, 512, shutdown.clone()));

    // The bounce MX.
    if let (Some(addr), Some(bounce_domain)) = (config.inbound_addr, config.bounce_domain.clone()) {
        let mx = Arc::new(BounceMx {
            hostname: hostname.clone(),
            bounce_domain,
            keys: keys.clone(),
            store: store.clone(),
            tls: tls(config.inbound_tls.as_ref())?,
        });
        let listener = TcpListener::bind(addr).await?;
        tracing::info!(%addr, "bounce MX listening");
        tasks.spawn(server::listen(listener, mx, 256, shutdown.clone()));
    }

    // The API.
    let api = router(ApiState {
        store: store.clone(),
        keys: keys.clone(),
        secret: Arc::from(config.api_secret.as_str()),
        signers: Arc::clone(&signers),
    });
    let listener = TcpListener::bind(config.api_addr).await?;
    tracing::info!(addr = %config.api_addr, "API listening");
    tasks.spawn(serve_api(listener, api, shutdown.clone()));

    // Delivery.
    let delivery = delivery(&config, &store, &resolver, &signers, &hostname, source_ip)?;
    tasks.spawn(delivery.run(shutdown.clone()));

    // Events.
    if let Some(settings) = &config.nats {
        let jetstream = connect_nats(settings).await?;
        tasks.spawn(crate::events::publish_loop(
            store.clone(),
            jetstream,
            config.events_subject.clone(),
            shutdown.clone(),
        ));
    } else {
        tracing::warn!("NATS_URL is not set: delivery events stay in the outbox");
    }

    // TLS-RPT.
    if let Some(from) = config.tlsrpt_from.clone() {
        let reporter = Reporter {
            store: store.clone(),
            resolver: Arc::clone(&resolver),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()?,
            from,
            submitter: hostname.clone(),
        };
        tasks.spawn(reporter.run(shutdown.clone()));
    }

    // Housekeeping, and the queue database's pool for the metrics.
    tasks.spawn(housekeeping(store.clone(), shutdown.clone()));
    tasks.spawn(crate::monitoring::sample_pool(
        store.pool().clone(),
        shutdown.clone(),
    ));

    shutdown.cancelled().await;
    tracing::info!("MTA stopping: finishing deliveries in progress");
    let drain = async { while tasks.join_next().await.is_some() {} };
    if tokio::time::timeout(Duration::from_secs(50), drain)
        .await
        .is_err()
    {
        tracing::warn!("deliveries still running at shutdown; their leases will expire");
    }
    Ok(())
}

/// For tests and tools: a listener address that is free.
pub fn local(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}
