//! WeldReach's background engine as the binary runs it: the send queue's
//! stream and consumer settings, and the [`SendEngine`] that
//! `weldsuite consume` (`reach-send`) and `weldsuite cron reach-send-sweep`
//! (inline, without NATS) share.

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
