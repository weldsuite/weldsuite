//! The reply path on `mail.inbound` (MAIL-010): Haraka accepts
//! `reply+<token>@REACH_INBOUND_DOMAIN` (the RCPT check asks
//! [`super::accepts_recipient`]), spools the message and publishes its key
//! with the envelope, as for every other recipient. [`ReachInboundRouter`]
//! wraps WeldMail's `mail-inbound` handler: it hands each WeldReach
//! recipient to [`ReachInbound::process`] first, then passes the envelope
//! with the remaining recipients to WeldMail, which removes the spooled
//! object once stored. A message only for WeldReach is removed here.
//!
//! WeldReach never retries a message (reach-api's handler parks what it
//! cannot process), so a redelivery (WeldMail asked for one, or removing
//! the object failed) finds the reply stored already and changes nothing:
//! deliveries de-duplicate on the Message-ID.

use std::sync::Arc;

use serde_json::Value;
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition, DynFileStore};

use super::handler::ReachInbound;

/// WeldMail's `mail-inbound` handler with WeldReach's replies taken out.
pub struct ReachInboundRouter {
    pub reach: ReachInbound,
    /// The handler for every other recipient (WeldMail's).
    pub mail: Arc<dyn BatchHandler>,
    /// The bucket Haraka spools to.
    pub spool: Arc<dyn DynFileStore>,
}

impl ReachInboundRouter {
    async fn to_mail(&self, delivery: &Delivery) -> Disposition {
        self.mail
            .handle(std::slice::from_ref(delivery))
            .await
            .pop()
            .unwrap_or_else(|| Disposition::retry("the mail handler gave no answer"))
    }

    /// One delivery.
    pub async fn handle_one(&self, delivery: &Delivery) -> Disposition {
        let Ok(mut envelope) = serde_json::from_slice::<Value>(&delivery.payload) else {
            return self.to_mail(delivery).await;
        };
        let recipients: Vec<String> = envelope["rcptTo"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let (ours, others): (Vec<String>, Vec<String>) =
            recipients.into_iter().partition(|r| self.reach.claims(r));
        if ours.is_empty() {
            return self.to_mail(delivery).await;
        }
        let Some(key) = envelope["key"].as_str().map(str::to_owned) else {
            return self.to_mail(delivery).await;
        };
        let object = match self.spool.get_boxed(&key).await {
            Ok(Some(object)) => object,
            Ok(None) => {
                tracing::info!(%key, "[reach-inbound] already handled (no spooled object)");
                return Disposition::Ack;
            }
            Err(error) => return Disposition::retry(format!("reading {key}: {error}")),
        };
        for recipient in &ours {
            // Never fails: what cannot be processed is parked or dropped.
            let _ = self.reach.process(recipient, &object.bytes).await;
        }
        if !others.is_empty() {
            envelope["rcptTo"] = Value::from(others);
            let payload = match serde_json::to_vec(&envelope) {
                Ok(payload) => payload,
                Err(error) => return Disposition::retry(format!("re-encoding {key}: {error}")),
            };
            let rest = Delivery {
                payload,
                ..delivery.clone()
            };
            return self.to_mail(&rest).await;
        }
        match self.spool.delete_boxed(&key).await {
            Ok(()) => Disposition::Ack,
            Err(error) => Disposition::retry(format!("removing {key}: {error}")),
        }
    }
}

impl BatchHandler for ReachInboundRouter {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(batch.len());
            for delivery in batch {
                out.push(self.handle_one(delivery).await);
            }
            out
        })
    }
}
