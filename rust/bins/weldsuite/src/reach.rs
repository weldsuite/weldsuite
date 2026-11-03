//! WeldReach's background engine as the binary runs it: the send queue's
//! stream and consumer settings, the [`SendEngine`] that `weldsuite consume`
//! (`reach-send`) and `weldsuite cron reach-send-sweep` (inline, without
//! NATS) share, the [`WarmupEngine`] of the warmup and slot crons, and the
//! warmup network ([`WarmupNetwork`]: its queues' stream and consumer
//! settings, and the network on lettre and async-imap).

use std::sync::Arc;
use std::time::Duration;

use async_nats::jetstream::stream;
use weldsuite_adapters_oss::ConsumerSpec;
use weldsuite_db::{Keyring, PgPool, Workspaces};
use weldsuite_events::EntityEventPublisher;
use weldsuite_ports::DynFlagSource;
use weldsuite_reach::send::{
    SEND_CONSUMER, SEND_STREAM, SEND_SUBJECT, SendEngine, SendTenant, SendTenants,
};
use weldsuite_reach::warmup::{WarmupEngine, WarmupTenant, WarmupTenants};
use weldsuite_reach::warmup_network::WarmupNetwork;
use weldsuite_reach::warmup_network::dispatch::{
    ENGAGE_CONSUMER, ENGAGE_SUBJECT, SEND_CONSUMER as WARMUP_SEND_CONSUMER,
    SEND_SUBJECT as WARMUP_SEND_SUBJECT, WARMUP_STREAM, WarmupQueueKind,
};

/// The `REACH_WARMUP` stream: the warmup network's two queues
/// (`reach.warmup.send`, `reach.warmup.engage`), a work queue on disk for a
/// day. A message is claimed for ten minutes, so one that is lost is handed
/// out again by the dispatcher.
pub(crate) fn warmup_stream_config(replicas: usize) -> stream::Config {
    stream::Config {
        name: WARMUP_STREAM.to_owned(),
        description: Some("WeldReach warmup network: mail to send and to engage".to_owned()),
        subjects: vec![WARMUP_SEND_SUBJECT.to_owned(), ENGAGE_SUBJECT.to_owned()],
        retention: stream::RetentionPolicy::WorkQueue,
        storage: stream::StorageType::File,
        max_age: Duration::from_hours(24),
        duplicate_window: Duration::from_secs(120),
        num_replicas: replicas.max(1),
        ..stream::Config::default()
    }
}

/// Where the warmup subscribers' dead letters go (`reach-warmup-dlq.>`).
pub(crate) const WARMUP_DLQ_STREAM: &str = "REACH_WARMUP_DLQ";
pub(crate) const WARMUP_DLQ_SUBJECT: &str = "reach-warmup-dlq";

/// How a warmup queue is consumed: batches of ten (`max_batch_size`), two
/// retries a minute apart (`max_retries = 2`, `retry({ delaySeconds: 60 })`),
/// then dead letters. An engagement holds an IMAP session, so the
/// acknowledgement window is long.
pub(crate) fn warmup_spec(kind: WarmupQueueKind) -> ConsumerSpec {
    let (durable, subject, what) = match kind {
        WarmupQueueKind::Send => (WARMUP_SEND_CONSUMER, WARMUP_SEND_SUBJECT, "sends"),
        WarmupQueueKind::Engage => (ENGAGE_CONSUMER, ENGAGE_SUBJECT, "engagements"),
    };
    ConsumerSpec {
        stream: WARMUP_STREAM.to_owned(),
        durable: durable.to_owned(),
        description: format!("WeldSuite WeldReach warmup {what} (the {durable} queue in Global)"),
        filter_subject: subject.to_owned(),
        deliver_new_only: false,
        max_retries: 2,
        max_deferrals: 0,
        retry_backoff: vec![Duration::from_secs(60)],
        ack_wait: Duration::from_secs(600),
        batch_size: 10,
        batch_wait: Duration::from_secs(5),
        workers: 2,
        dead_letter_subject: WARMUP_DLQ_SUBJECT.to_owned(),
        dedupe_capacity: 1_000,
    }
}

/// The warmup network on the master database, lettre for SMTP, async-imap
/// over rustls for IMAP, and the given flags (the `weldreach-warmup` kill
/// switch). `WELDREACH_WARMUP_KEY` opens the pool's logins; without it
/// every mailbox's login is unavailable and the jobs park them.
pub(crate) fn warmup_network(
    master: PgPool,
    flags: Arc<dyn DynFlagSource>,
) -> Result<WarmupNetwork, weldsuite_ports::PortError> {
    Ok(WarmupNetwork {
        master,
        warmup_key: std::env::var("WELDREACH_WARMUP_KEY")
            .ok()
            .filter(|v| !v.is_empty()),
        smtp: Arc::new(weldsuite_reach::LettreSmtp),
        imap: Arc::new(weldsuite_adapters_oss::AsyncImapConnector::new()?),
        flags,
    })
}

/// The `REACH_SEND` stream: a work queue on disk for a day, deduplicated
/// for two minutes on the workspace and minute.
pub(crate) fn send_stream_config(replicas: usize) -> stream::Config {
    stream::Config {
        name: SEND_STREAM.to_owned(),
        description: Some("WeldReach send sweep: workspaces with outreach due".to_owned()),
        subjects: vec![SEND_SUBJECT.to_owned()],
        retention: stream::RetentionPolicy::WorkQueue,
        storage: stream::StorageType::File,
        max_age: Duration::from_hours(24),
        duplicate_window: Duration::from_secs(120),
        num_replicas: replicas.max(1),
        ..stream::Config::default()
    }
}

/// Where `reach-send` dead letters go (`reach-send-dlq.send`).
pub(crate) const SEND_DLQ_STREAM: &str = "REACH_SEND_DLQ";

/// How `reach-send` consumes: one workspace at a time per worker, a long
/// acknowledgement window (a tick sends up to a hundred emails), retries
/// after a minute (`retry({ delaySeconds: 60 })`), then dead letters.
pub(crate) fn send_spec() -> ConsumerSpec {
    ConsumerSpec {
        stream: SEND_STREAM.to_owned(),
        durable: SEND_CONSUMER.to_owned(),
        description: "WeldSuite WeldReach sends (the reach-send queue in Global)".to_owned(),
        filter_subject: SEND_SUBJECT.to_owned(),
        deliver_new_only: false,
        max_retries: 3,
        max_deferrals: 0,
        retry_backoff: vec![Duration::from_secs(60)],
        ack_wait: Duration::from_secs(300),
        batch_size: 1,
        batch_wait: Duration::from_secs(5),
        workers: 4,
        dead_letter_subject: "reach-send-dlq".to_owned(),
        dedupe_capacity: 1_000,
    }
}

/// The engine on the app's databases, the customer-mailbox SMTP (lettre)
/// and the given events and flags.
pub(crate) fn send_engine(
    master: PgPool,
    workspaces: &Arc<Workspaces>,
    keyring: Keyring,
    events: EntityEventPublisher,
    flags: Arc<dyn DynFlagSource>,
) -> SendEngine {
    let workspaces = Arc::clone(workspaces);
    let tenants: SendTenants = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            let tenant = workspaces
                .tenant(&reference)
                .await
                .map_err(|error| error.to_string())?;
            Ok(SendTenant {
                db: tenant.db,
                clerk_org_id: tenant.clerk_org_id,
            })
        })
    });
    SendEngine {
        master,
        tenants,
        keyring,
        transport: Arc::new(weldsuite_reach::LettreSmtp),
        events,
        flags,
    }
}

/// The warmup crons' engine: the app's databases, Mailpool over HTTPS
/// (`MAILPOOL_API_KEY`, `MAILPOOL_API_URL`) and the warmup pool's key
/// (`WELDREACH_WARMUP_KEY`), from the process environment.
pub(crate) fn warmup_engine(
    master: PgPool,
    workspaces: &Arc<Workspaces>,
    keyring: Keyring,
    events: EntityEventPublisher,
) -> Result<WarmupEngine, weldsuite_ports::PortError> {
    let workspaces = Arc::clone(workspaces);
    let tenants: WarmupTenants = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            let tenant = workspaces
                .tenant(&reference)
                .await
                .map_err(|error| error.to_string())?;
            Ok(WarmupTenant {
                db: tenant.db,
                workspace_id: tenant.workspace_id,
                clerk_org_id: tenant.clerk_org_id,
            })
        })
    });
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let http = weldsuite_adapters_oss::ReqwestOutbound::new(Duration::from_secs(30))?;
    Ok(WarmupEngine {
        master,
        tenants,
        keyring,
        warmup_key: env("WELDREACH_WARMUP_KEY"),
        mailpool_key: env("MAILPOOL_API_KEY"),
        mailpool_url: env("MAILPOOL_API_URL"),
        http: weldsuite_ports::OutboundHttp(Arc::new(http)),
        events,
    })
}
