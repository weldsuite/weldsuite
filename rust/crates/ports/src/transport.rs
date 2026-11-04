//! Customer mail transport: one built MIME message handed over for one
//! envelope. The TypeScript workers send customer mail through the
//! Cloudflare `SEND_EMAIL` binding (`new EmailMessage(from, to, raw)`, one
//! envelope recipient per call, `@weldsuite/email/providers/cloudflare`);
//! the Kubernetes editions through SMTP submission to a relay
//! (`weldsuite-adapters-oss`), under credentials of their own, separate from
//! system mail ([`crate::SystemMail`]), so a workspace's sending cannot hurt
//! WeldSuite's own mail (ADR MAIL-010).
//!
//! The port is deliberately as small as the binding: building the message
//! and fanning it out over its recipients is the caller's
//! (`weldsuite_mail_domain::outbound::transmit`), so the per-recipient
//! outcomes (sent, needs verifying, suppressed, refused) work out the same
//! on every transport.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::BoxFuture;

/// One envelope: who the message is from and the one recipient it goes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    /// The sender as the Cloudflare binding takes it: `"Name" <address>` or
    /// a bare address. SMTP takes [`Envelope::mail_from`].
    pub from: String,
    /// The envelope recipient (`RCPT TO`), a bare address.
    pub to: String,
}

impl Envelope {
    /// The bare address of [`Envelope::from`], for `MAIL FROM`.
    pub fn mail_from(&self) -> &str {
        let trimmed = self.from.trim();
        match (trimmed.rfind('<'), trimmed.ends_with('>')) {
            (Some(open), true) => trimmed[open + 1..trimmed.len() - 1].trim(),
            _ => trimmed,
        }
    }
}

/// Why a transport did not take one envelope. `code` is Cloudflare's
/// Email Service error code (`E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`,
/// `E_RECIPIENT_SUPPRESSED`, `E_RECIPIENT_NOT_ALLOWED`,
/// `E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`), which adapters
/// for other transports map their refusals onto; `None` for a plain failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportFailure {
    pub code: Option<String>,
    pub message: String,
}

impl TransportFailure {
    pub fn new(code: Option<&str>, message: impl Into<String>) -> Self {
        Self {
            code: code.map(str::to_owned),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for TransportFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.code {
            Some(code) => write!(f, "({code}) {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for TransportFailure {}

/// Delivers one RFC 5322 message to one envelope recipient (the
/// `send_email` binding's `send(EmailMessage)`). Object safe.
///
/// `Ok(Some(id))` is the Message-ID the recipient receives when the transport
/// replaces the message's own: Cloudflare does, with a different
/// `<id@sender-domain>` for every envelope, and its binding resolves `send()`
/// with it. `Ok(None)`: the message goes out under the Message-ID it was
/// built with, as over SMTP.
pub trait MailTransport: Send + Sync {
    fn send<'a>(
        &'a self,
        envelope: &'a Envelope,
        raw: &'a [u8],
    ) -> BoxFuture<'a, Result<Option<String>, TransportFailure>>;
}

impl<T: MailTransport + ?Sized> MailTransport for Arc<T> {
    fn send<'a>(
        &'a self,
        envelope: &'a Envelope,
        raw: &'a [u8],
    ) -> BoxFuture<'a, Result<Option<String>, TransportFailure>> {
        (**self).send(envelope, raw)
    }
}

/// One envelope a [`RecordingMailTransport`] took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentEnvelope {
    pub envelope: Envelope,
    pub raw: Vec<u8>,
}

/// The Message-ID a [`RecordingMailTransport`] answers with for a recipient.
type MessageIdFor = Box<dyn Fn(&str) -> String + Send + Sync>;

/// Records instead of sending, for tests. Recipients listed with
/// [`RecordingMailTransport::refuse`] fail with that code (and are not
/// recorded), as the binding refuses them. With
/// [`RecordingMailTransport::delivering_ids`] it answers like Cloudflare, with
/// a Message-ID of its own per envelope.
#[derive(Default)]
pub struct RecordingMailTransport {
    sent: Mutex<Vec<SentEnvelope>>,
    refusals: Mutex<Vec<(String, Option<String>)>>,
    message_id: Option<MessageIdFor>,
}

impl std::fmt::Debug for RecordingMailTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecordingMailTransport")
            .field("sent", &self.sent)
            .field("refusals", &self.refusals)
            .field("delivers_ids", &self.message_id.is_some())
            .finish()
    }
}

impl RecordingMailTransport {
    pub fn new() -> Self {
        Self::default()
    }

    /// Refuse `recipient` with Cloudflare's `code` (`None`: a plain failure).
    #[must_use]
    pub fn refuse(self, recipient: &str, code: Option<&str>) -> Self {
        lock(&self.refusals).push((recipient.to_lowercase(), code.map(str::to_owned)));
        self
    }

    /// Answer every envelope with the Message-ID `id_for(recipient)`, the way
    /// Cloudflare replaces the message's own.
    #[must_use]
    pub fn delivering_ids(
        mut self,
        id_for: impl Fn(&str) -> String + Send + Sync + 'static,
    ) -> Self {
        self.message_id = Some(Box::new(id_for));
        self
    }

    /// Every envelope taken, in order.
    pub fn sent(&self) -> Vec<SentEnvelope> {
        lock(&self.sent).clone()
    }

    pub fn clear(&self) {
        lock(&self.sent).clear();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl MailTransport for RecordingMailTransport {
    fn send<'a>(
        &'a self,
        envelope: &'a Envelope,
        raw: &'a [u8],
    ) -> BoxFuture<'a, Result<Option<String>, TransportFailure>> {
        let refusal = lock(&self.refusals)
            .iter()
            .find(|(recipient, _)| *recipient == envelope.to.to_lowercase())
            .map(|(_, code)| code.clone());
        let result = if let Some(code) = refusal {
            Err(TransportFailure {
                code,
                message: format!("refused {}", envelope.to),
            })
        } else {
            lock(&self.sent).push(SentEnvelope {
                envelope: envelope.clone(),
                raw: raw.to_vec(),
            });
            Ok(self.message_id.as_ref().map(|id_for| id_for(&envelope.to)))
        };
        Box::pin(std::future::ready(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mail_from_is_the_bare_address() {
        let named = Envelope {
            from: "\"Tom\" <tom@acme.com>".to_owned(),
            to: "a@x.com".to_owned(),
        };
        assert_eq!(named.mail_from(), "tom@acme.com");
        let bare = Envelope {
            from: " tom@acme.com ".to_owned(),
            to: "a@x.com".to_owned(),
        };
        assert_eq!(bare.mail_from(), "tom@acme.com");
    }

    #[tokio::test]
    async fn records_and_refuses() {
        let transport =
            RecordingMailTransport::new().refuse("Bad@X.com", Some("E_RECIPIENT_SUPPRESSED"));
        let ok = Envelope {
            from: "tom@acme.com".to_owned(),
            to: "a@x.com".to_owned(),
        };
        let bad = Envelope {
            from: "tom@acme.com".to_owned(),
            to: "bad@x.com".to_owned(),
        };
        assert_eq!(transport.send(&ok, b"raw").await.expect("sent"), None);
        let refused = transport.send(&bad, b"raw").await.expect_err("refused");
        assert_eq!(refused.code.as_deref(), Some("E_RECIPIENT_SUPPRESSED"));
        assert_eq!(transport.sent().len(), 1);
        transport.clear();
        assert_eq!(transport.sent().len(), 0);
    }

    #[tokio::test]
    async fn answers_with_a_message_id_per_envelope_when_asked() {
        let transport = RecordingMailTransport::new().delivering_ids(|to| format!("<cf.{to}>"));
        let envelope = Envelope {
            from: "tom@acme.com".to_owned(),
            to: "a@x.com".to_owned(),
        };
        assert_eq!(
            transport
                .send(&envelope, b"raw")
                .await
                .expect("sent")
                .as_deref(),
            Some("<cf.a@x.com>")
        );
    }
}
