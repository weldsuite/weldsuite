//! mail-api's queue consumers (`queue()` in `src/index.ts`), by queue:
//!
//! - `mail-outbound-review-<env>`: AI reviews of templates the ledgers
//!   queued ([`review_batch`]).
//! - `mail-sending-events-<env>`: delivery events (bounces, complaints),
//!   from Cloudflare on Global and from the EU edition's own MTA on
//!   Kubernetes (`MAIL_SENDING_EVENTS`, `mail.sending-events`;
//!   [`sending_events_batch`], [`SendingEventsSubscriber`]).
//!
//! On Kubernetes both arrive on NATS (`JetStream`) and run under
//! `weldsuite consume` (ADR MAIL-010); the batch handlers here are what that
//! loop calls, one batch at a time, acking or retrying as the TypeScript
//! consumers do.

use std::sync::Arc;

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
use weldsuite_ports::{BatchHandler, BoxFuture, Disposition};

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
/// databases could not be reached. [`SendingEventsSubscriber`] calls it under
/// `weldsuite consume`.
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

/// Tenant databases by workspace reference, as [`crate::scheduled`] takes
/// them, for the delivery events.
pub struct ClosureTenants(pub crate::scheduled::TenantDatabases);

impl TenantDatabases for ClosureTenants {
    fn tenant<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<PgPool, String>> {
        (self.0)(reference.to_owned())
    }
}

/// The `mail-sending-events` subscriber of `weldsuite consume`: the
/// `mail-sending-events-<env>` queue consumer of mail-api, on the
/// `MAIL_SENDING_EVENTS` stream the EU edition's MTA publishes to (ADR
/// MAIL-011). The batch is one unit, as in TypeScript: every message is
/// acked, or every one retried.
pub struct SendingEventsSubscriber {
    master: PgPool,
    ledger: Option<Arc<dyn OutboundLedger>>,
    tenants: Arc<dyn TenantDatabases>,
}

impl SendingEventsSubscriber {
    pub fn new(
        master: PgPool,
        ledger: Option<Arc<dyn OutboundLedger>>,
        tenants: Arc<dyn TenantDatabases>,
    ) -> Self {
        Self {
            master,
            ledger,
            tenants,
        }
    }
}

impl BatchHandler for SendingEventsSubscriber {
    fn handle<'a>(
        &'a self,
        batch: &'a [weldsuite_ports::Delivery],
    ) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let bodies = sending_event_bodies(batch);
            let outcome = sending_events_batch(
                &bodies,
                &self.master,
                self.ledger.as_deref(),
                self.tenants.as_ref(),
            )
            .await;
            let disposition = match outcome {
                Delivery::Ack => Disposition::Ack,
                Delivery::Retry => Disposition::retry("the databases could not be reached"),
            };
            vec![disposition; batch.len()]
        })
    }
}

/// The batch's JSON bodies; one that isn't JSON is dropped (acked with the
/// batch), as a malformed event is.
fn sending_event_bodies(batch: &[weldsuite_ports::Delivery]) -> Vec<Value> {
    batch
        .iter()
        .filter_map(|delivery| {
            serde_json::from_slice(&delivery.payload)
                .inspect_err(|error| {
                    tracing::warn!(%error, "[outbound-events] a message that is not JSON; dropped");
                })
                .ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delivery(payload: &[u8]) -> weldsuite_ports::Delivery {
        weldsuite_ports::Delivery {
            subject: "mail.sending-events".to_owned(),
            payload: payload.to_vec(),
            attempt: 1,
            deferrals: 0,
        }
    }

    #[test]
    fn bodies_skip_what_is_not_json() {
        let bounce = serde_json::json!({
            "type": "cf.email.sending.message.bounced",
            "metadata": { "eventTimestamp": "2026-11-07T12:00:00.000Z" },
            "payload": {
                "sender": "anna@acme.eu",
                "recipient": "bob@example.com",
                "bounce": { "type": "hard" },
            },
        });
        let batch = [
            delivery(bounce.to_string().as_bytes()),
            delivery(b"not json"),
        ];
        assert_eq!(sending_event_bodies(&batch), vec![bounce]);
    }
}
