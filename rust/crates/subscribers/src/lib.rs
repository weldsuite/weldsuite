//! The entity-event hub subscribers (EVT-001), ported from the TypeScript
//! queue consumers for the `weldsuite consume` role:
//!
//! | Subscriber | TypeScript | What it writes |
//! |---|---|---|
//! | [`AuditSubscriber`] | `apps/workers/audit-log-worker` | `audit_logs` in the tenant DB |
//! | [`SearchSubscriber`] | app-api `queue/search-index-consumer.ts` | `search_index` chunks and embeddings in the tenant DB |
//! | [`WebhooksSubscriber`] | `apps/workers/integration-webhook-worker` (`entity-webhooks-consumer.ts`) | signed POSTs, `webhook_deliveries`, `external_webhooks` counters |
//! | [`RealtimeSubscriber`] | `apps/workers/realtime-worker` (`entity-realtime-consumer.ts`) | `WorkspaceHub` publishes through the realtime port |
//!
//! Analytics (Cloudflare Pipelines into Iceberg), WeldConnect and WeldAgent
//! have no consumer on Kubernetes yet; [`registry::SUBSCRIBERS`] says which
//! are ported. Each subscriber implements `weldsuite_ports::BatchHandler`:
//! it decides per delivery (ack, retry, defer), and the bus adapter does the
//! acking, the backoff and the dead letters.

pub mod audit;
pub mod event;
mod js;
pub mod realtime;
pub mod registry;
pub mod search;
pub mod tenants;
pub mod webhooks;

use std::sync::Arc;

use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition};

/// A subscriber behind its topic patterns: deliveries whose `eventType` the
/// patterns do not match are acked without reaching it, as the hub worker
/// never sends them (`matchEntityEventSubscribers`). The consumer's filter
/// subject already narrows to the same set; this keeps the rule exact for
/// several patterns, which one NATS filter subject cannot express.
pub struct Routed {
    topics: &'static [&'static str],
    inner: Arc<dyn BatchHandler>,
}

impl Routed {
    pub fn new(topics: &'static [&'static str], inner: Arc<dyn BatchHandler>) -> Self {
        Self { topics, inner }
    }
}

impl BatchHandler for Routed {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let matched: Vec<bool> = batch
                .iter()
                .map(|delivery| {
                    HubEvent::parse(&delivery.payload)
                        .is_ok_and(|event| topic_matches(self.topics, &event.event_type))
                })
                .collect();
            if matched.iter().all(|m| *m) {
                return self.inner.handle(batch).await;
            }
            let routed: Vec<Delivery> = batch
                .iter()
                .zip(&matched)
                .filter(|(_, m)| **m)
                .map(|(delivery, _)| delivery.clone())
                .collect();
            let mut answers = self.inner.handle(&routed).await.into_iter();
            matched
                .iter()
                .map(|m| {
                    if *m {
                        answers
                            .next()
                            .unwrap_or_else(|| Disposition::retry("the handler gave no answer"))
                    } else {
                        Disposition::Ack
                    }
                })
                .collect()
        })
    }
}

pub use audit::AuditSubscriber;
pub use event::{EventMetadata, HubEvent, OrderedObject};
pub use realtime::RealtimeSubscriber;
pub use registry::{SUBSCRIBERS, Subscriber, filter_subject, subscriber, topic_matches};
pub use search::SearchSubscriber;
pub use tenants::{ResolvedTenant, StaticTenants, TenantError, Tenants, WorkspaceTenants};
pub use webhooks::{WebhookHttp, WebhooksSubscriber, run_webhook_retry_sweep};
