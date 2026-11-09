//! Delivery events, in the shape of Cloudflare Email Sending's events so the
//! one parser (`weldsuite_mail_domain::outbound::delivery_events`) serves
//! Global and Kubernetes. They are written to the outbox table in the same
//! transaction as the state change ([`crate::store`]) and published from
//! there on NATS `JetStream` ([`publish_loop`]): at least once, with the
//! outbox row id as `Nats-Msg-Id` so the stream's duplicate window drops a
//! re-publish.

use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::store::Store;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Delivered,
    Deferred,
    HardBounce,
    SoftBounce,
    Complained,
}

/// The event JSON. `detail` is the SMTP response (or the complaint type for
/// a complaint).
pub fn event(kind: Kind, sender: &str, recipient: &str, detail: &str) -> Value {
    let name = match kind {
        Kind::Delivered => "delivered",
        Kind::Deferred => "deferred",
        Kind::HardBounce | Kind::SoftBounce => "bounced",
        Kind::Complained => "complained",
    };
    let mut payload = json!({
        "sender": sender.to_lowercase(),
        "recipient": recipient.to_lowercase(),
    });
    match kind {
        Kind::Complained => {
            payload["complaint"] =
                json!({ "type": if detail.is_empty() { "abuse" } else { detail } });
        }
        Kind::HardBounce | Kind::SoftBounce => {
            payload["bounce"] =
                json!({ "type": if kind == Kind::HardBounce { "hard" } else { "soft" } });
            payload["delivery"] = json!({ "smtpResponse": detail });
        }
        Kind::Delivered | Kind::Deferred => {
            payload["delivery"] = json!({ "smtpResponse": detail });
        }
    }
    json!({
        "type": format!("cf.email.sending.message.{name}"),
        "metadata": { "eventTimestamp": now_iso(), "source": "weldsuite-mta" },
        "payload": payload,
    })
}

/// Now as `2026-11-07T12:00:00.000Z`.
pub fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    now.format(&format).unwrap_or_default()
}

/// Publishes the outbox until `shutdown`. Without NATS the rows wait.
pub async fn publish_loop(
    store: Store,
    jetstream: async_nats::jetstream::Context,
    subject: String,
    shutdown: CancellationToken,
) {
    loop {
        let published = match publish_batch(&store, &jetstream, &subject).await {
            Ok(count) => count,
            Err(error) => {
                tracing::warn!(%error, "publishing delivery events failed");
                0
            }
        };
        let pause = if published == 0 {
            Duration::from_secs(2)
        } else {
            Duration::ZERO
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = tokio::time::sleep(pause) => {}
        }
    }
}

async fn publish_batch(
    store: &Store,
    jetstream: &async_nats::jetstream::Context,
    subject: &str,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let pending = store.outbox_pending(200).await?;
    let mut done = Vec::with_capacity(pending.len());
    for (id, event) in &pending {
        let mut headers = async_nats::HeaderMap::new();
        headers.insert("Nats-Msg-Id", format!("mta-outbox-{id}").as_str());
        let payload = serde_json::to_vec(event)?;
        let ack = jetstream
            .publish_with_headers(subject.to_owned(), headers, payload.into())
            .await?;
        ack.await?;
        done.push(*id);
    }
    store.outbox_published(&done).await?;
    Ok(done.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_cloudflare_shaped_events() {
        let bounce = event(
            Kind::HardBounce,
            "Anna@Acme.eu",
            "bob@example.com",
            "550 5.1.1 unknown",
        );
        assert_eq!(bounce["type"], "cf.email.sending.message.bounced");
        assert_eq!(bounce["payload"]["sender"], "anna@acme.eu");
        assert_eq!(bounce["payload"]["bounce"]["type"], "hard");
        assert_eq!(
            bounce["payload"]["delivery"]["smtpResponse"],
            "550 5.1.1 unknown"
        );
        assert!(
            bounce["metadata"]["eventTimestamp"]
                .as_str()
                .is_some_and(|t| t.ends_with('Z') && t.len() == 24)
        );
        let complaint = event(Kind::Complained, "a@b.eu", "c@d.eu", "");
        assert_eq!(complaint["payload"]["complaint"]["type"], "abuse");
        assert_eq!(
            event(Kind::SoftBounce, "a@b.eu", "c@d.eu", "x")["payload"]["bounce"]["type"],
            "soft"
        );
        assert_eq!(
            event(Kind::Delivered, "a@b.eu", "c@d.eu", "250 ok")["type"],
            "cf.email.sending.message.delivered"
        );
    }
}
