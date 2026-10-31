//! The `mail.inbound` subscriber of `weldsuite consume` (MAIL-010): Haraka
//! put the raw MIME in the mail bucket and published its key with the SMTP
//! envelope; this reads it, runs the storage pipeline, then the helpdesk and
//! accounting fan-out, and removes the spooled object.
//!
//! Idempotent on the object key: Haraka publishes with `Nats-Msg-Id` = the
//! key (the stream drops a repeated publish), a delivery whose object is
//! gone was handled already and is acknowledged, every mailbox ignores a
//! Message-ID it already holds, and a message without one gets an id
//! derived from the key. As on Global, storage is retried until it
//! succeeds and the fan-out runs once, after it, best effort.

use serde::Deserialize;
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition, DynFileStore};

use crate::context::InboundContext;
use crate::deliver::process_inbound_email;
use crate::fanout::{process_accounting_inbox, process_helpdesk_inbox};
use crate::parsed::parse_inbound;
use crate::recipients::collect_recipient_emails;
use crate::spam::{SpamInput, SpamOptions, score_inbound_spam};

/// What Haraka publishes on `mail.inbound`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundEnvelope {
    /// The raw MIME's key in the mail bucket.
    pub key: String,
    /// `MAIL FROM`.
    #[serde(default)]
    pub mail_from: Option<String>,
    /// The accepted `RCPT TO` addresses.
    pub rcpt_to: Vec<String>,
    #[serde(default)]
    pub remote_ip: Option<String>,
    #[serde(default)]
    pub received_at: Option<String>,
}

/// The default subject and stream.
pub const DEFAULT_SUBJECT: &str = "mail.inbound";
pub const DEFAULT_STREAM: &str = "MAIL_INBOUND";

/// The `mail.inbound` handler.
pub struct MailInboundSubscriber {
    ctx: InboundContext,
    /// The bucket Haraka spools to (the mail bucket).
    spool: std::sync::Arc<dyn DynFileStore>,
}

impl MailInboundSubscriber {
    pub fn new(ctx: InboundContext, spool: std::sync::Arc<dyn DynFileStore>) -> Self {
        Self { ctx, spool }
    }

    /// One delivery.
    #[allow(clippy::too_many_lines)] // the worker's `emailHandler`, step by step
    pub async fn handle_one(&self, delivery: &Delivery) -> Disposition {
        let envelope: InboundEnvelope = match serde_json::from_slice(&delivery.payload) {
            Ok(envelope) => envelope,
            Err(error) => {
                tracing::error!(%error, "[Email] an inbound envelope that is not JSON; dropped");
                return Disposition::Ack;
            }
        };
        let object = match self.spool.get_boxed(&envelope.key).await {
            Ok(Some(object)) => object,
            Ok(None) => {
                tracing::info!(key = %envelope.key, "[Email] already handled (no spooled object)");
                return Disposition::Ack;
            }
            Err(error) => return Disposition::retry(format!("reading {}: {error}", envelope.key)),
        };
        tracing::info!(
            key = %envelope.key,
            from = envelope.mail_from.as_deref().unwrap_or_default(),
            to = %envelope.rcpt_to.join(", "),
            bytes = object.bytes.len(),
            "[Email] Inbound"
        );
        let email_id = weldsuite_kit::random_string(
            21,
            "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict",
        );
        let now = weldsuite_mail_domain::outbound::clock::now_ms();
        let (email, attachments) = match parse_inbound(
            &object.bytes,
            &envelope.rcpt_to,
            &email_id,
            &envelope.key,
            now,
        ) {
            Ok(parsed) => parsed,
            Err(error) => {
                // The worker rejects such a message (`setReject`); here it
                // was accepted already, so it stays in the spool for an
                // operator and is not retried.
                tracing::error!(%error, key = %envelope.key, "[Email] Failed to parse incoming message");
                return Disposition::Ack;
            }
        };
        let processed = match process_inbound_email(&self.ctx, &email, &attachments).await {
            Ok(processed) => processed,
            Err(error) => {
                tracing::error!(%error, key = %envelope.key, "[Email] Storage pipeline failed");
                return Disposition::retry(format!("storage pipeline: {error}"));
            }
        };
        tracing::info!(
            stored = processed.stored,
            notified = processed.notified,
            "[Email] Processed"
        );
        if processed.recipients == 0 {
            tracing::warn!(
                recipients = %collect_recipient_emails(&email).join(", "),
                "[Email] No recipients matched"
            );
        }
        // Stored: the spooled copy goes, so a redelivery is a no-op.
        if let Err(error) = self.spool.delete_boxed(&envelope.key).await {
            return Disposition::retry(format!("removing {}: {error}", envelope.key));
        }
        let names: Vec<String> = attachments
            .iter()
            .map(|a| a.file_name.clone())
            .filter(|n| !n.is_empty())
            .collect();
        let spam = score_inbound_spam(
            &SpamInput {
                from: Some(&email.from),
                to: &email.to,
                subject: Some(&email.subject),
                text_body: email.text_body.as_deref(),
                html_body: email.html_body.as_deref(),
                headers: &email.headers,
                spf_status: email.spf_status.as_deref(),
                dkim_status: email.dkim_status.as_deref(),
                dmarc_status: email.dmarc_status.as_deref(),
            },
            &SpamOptions {
                attachment_names: names,
                is_existing_ham_thread: false,
                recipient_emails: Some(collect_recipient_emails(&email)),
            },
        );
        if spam.is_spam {
            tracing::info!(
                score = spam.score,
                reasons = %spam.reasons.join(", "),
                "[Email] Skipping helpdesk/accounting fan-out (spam)"
            );
            return Disposition::Ack;
        }
        let (accounting, helpdesk) = tokio::join!(
            process_accounting_inbox(&self.ctx, &email, &attachments),
            process_helpdesk_inbox(&self.ctx, &email, &attachments),
        );
        match accounting {
            Ok(ids) if !ids.is_empty() => {
                tracing::info!(documents = ids.len(), "[Email] Accounting inbox");
            }
            Ok(_) => {}
            Err(error) => tracing::error!(%error, "[Email] Accounting inbox failed"),
        }
        match helpdesk {
            Ok(ids) if !ids.is_empty() => {
                tracing::info!(conversations = ids.len(), "[Email] Helpdesk inbox");
            }
            Ok(_) => {}
            Err(error) => tracing::error!(%error, "[Email] Helpdesk inbox failed"),
        }
        Disposition::Ack
    }
}

impl BatchHandler for MailInboundSubscriber {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes() {
        let envelope: InboundEnvelope = serde_json::from_str(
            r#"{"key":"inbound/2026/10/31/a.eml","mailFrom":"a@b.c","rcptTo":["x@y.z"],"remoteIp":"203.0.113.9","receivedAt":"2026-10-31T00:00:00.000Z","size":12}"#,
        )
        .expect("an envelope");
        assert_eq!(envelope.rcpt_to, ["x@y.z"]);
        assert_eq!(envelope.mail_from.as_deref(), Some("a@b.c"));
    }
}
