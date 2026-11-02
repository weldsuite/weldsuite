//! mail-api's queue consumers (`queue()` in `src/index.ts`), by queue:
//!
//! - `mail-outbound-review-<env>`: AI reviews of templates the ledgers
//!   queued ([`review_batch`]).
//! - `mail-sending-events-<env>`: delivery events (bounces, complaints),
//!   from Cloudflare on Global and from the relay's webhook on Kubernetes
//!   ([`sending_events_batch`]).
//!
//! On Kubernetes both arrive on NATS (`JetStream`) and run under
//! `weldsuite consume` (ADR MAIL-010); the batch handlers here are what that
//! loop calls, one batch at a time, acking or retrying as the TypeScript
//! consumers do.

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_mail_domain::outbound::OutboundLedger;
use weldsuite_mail_domain::outbound::OutboundReviewMessage;
use weldsuite_mail_domain::outbound::delivery_events::{
    DeliveryEventsDeps, TenantDatabases, handle_sending_events_batch,
};
use weldsuite_mail_domain::outbound::review::{
    Delivery, TemplateClassifier, handle_outbound_review_batch,
};

/// The queues this module consumes, by name prefix (`<prefix><env>`).
pub const OUTBOUND_REVIEW_QUEUE: &str = "mail-outbound-review-";
pub const SENDING_EVENTS_QUEUE: &str = "mail-sending-events-";

/// `handleOutboundReviewBatch`: one outcome per message, in order. A body
/// that isn't a review message is acked and dropped.
pub async fn review_batch(
    bodies: &[Value],
    ledger: Option<&dyn OutboundLedger>,
    classifier: &dyn TemplateClassifier,
) -> Vec<Delivery> {
    let mut parsed = Vec::with_capacity(bodies.len());
    let mut at = Vec::with_capacity(bodies.len());
    for (index, body) in bodies.iter().enumerate() {
        if let Ok(message) = serde_json::from_value::<OutboundReviewMessage>(body.clone()) {
            parsed.push(message);
            at.push(index);
        }
    }
    let outcomes = handle_outbound_review_batch(&parsed, ledger, classifier).await;
    let mut all = vec![Delivery::Ack; bodies.len()];
    for (index, outcome) in at.into_iter().zip(outcomes) {
        all[index] = outcome;
    }
    all
}

/// `handleSendingEventsBatch`: the whole batch is acked, or retried when the
/// databases could not be reached.
pub async fn sending_events_batch(
    bodies: &[Value],
    master: &PgPool,
    ledger: Option<&dyn OutboundLedger>,
    tenants: &dyn TenantDatabases,
) -> Delivery {
    let deps = DeliveryEventsDeps {
        master,
        ledger,
        tenants,
    };
    handle_sending_events_batch(&deps, bodies).await
}
