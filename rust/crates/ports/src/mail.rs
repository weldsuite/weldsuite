//! System mail: rendered emails handed to a transport. The TypeScript workers
//! send through `@weldsuite/emails` (`EmailTransport`, over the Cloudflare
//! `SEND_EMAIL` binding); the Kubernetes editions through SMTP
//! (`weldsuite-adapters-oss`). Rendering is not the port's business: see the
//! `weldsuite-emails` crate.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::{BoxFuture, PortError};

/// A bare address with an optional display name (`Mailbox`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mailbox {
    pub email: String,
    pub name: Option<String>,
}

impl Mailbox {
    pub fn new(email: impl Into<String>) -> Self {
        Self {
            email: email.into(),
            name: None,
        }
    }

    #[must_use]
    pub fn named(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }
}

/// A file sent with the email (`OutgoingAttachment`): raw bytes, never
/// pre-encoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailAttachment {
    pub filename: String,
    /// e.g. `application/pdf`, `text/calendar; method=REQUEST; charset=UTF-8`.
    pub content_type: String,
    pub content: Vec<u8>,
}

/// A fully rendered email, ready for a transport (`OutgoingEmail`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingMail {
    pub from: Mailbox,
    pub to: Vec<Mailbox>,
    pub cc: Vec<Mailbox>,
    pub bcc: Vec<Mailbox>,
    pub reply_to: Option<Mailbox>,
    pub subject: String,
    pub html: String,
    pub text: String,
    pub attachments: Vec<MailAttachment>,
    /// Extra headers, in order.
    pub headers: Vec<(String, String)>,
}

/// What the transport reports (`SendResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentMail {
    pub message_id: String,
    /// Which transport delivered it (`smtp`, `recording`).
    pub transport: &'static str,
    /// Recipients the transport refused; the rest were accepted.
    pub rejected: Vec<String>,
}

/// Delivers a rendered email (`EmailTransport`).
pub trait SystemMail: Send + Sync {
    fn send(&self, mail: OutgoingMail) -> impl Future<Output = Result<SentMail, PortError>> + Send;
}

/// [`SystemMail`] with a boxed future, for state that picks its transport at
/// runtime.
pub trait DynSystemMail: Send + Sync {
    fn send_boxed(&self, mail: OutgoingMail) -> BoxFuture<'_, Result<SentMail, PortError>>;
}

impl<M: SystemMail> DynSystemMail for M {
    fn send_boxed(&self, mail: OutgoingMail) -> BoxFuture<'_, Result<SentMail, PortError>> {
        Box::pin(self.send(mail))
    }
}

impl SystemMail for dyn DynSystemMail {
    fn send(&self, mail: OutgoingMail) -> impl Future<Output = Result<SentMail, PortError>> + Send {
        self.send_boxed(mail)
    }
}

impl<M: SystemMail + ?Sized> SystemMail for Arc<M> {
    fn send(&self, mail: OutgoingMail) -> impl Future<Output = Result<SentMail, PortError>> + Send {
        (**self).send(mail)
    }
}

/// Records instead of sending (`memoryTransport`), for tests and conformance.
#[derive(Debug, Default)]
pub struct RecordingSystemMail {
    sent: Mutex<Vec<OutgoingMail>>,
    fail: bool,
}

impl RecordingSystemMail {
    pub fn new() -> Self {
        Self::default()
    }

    /// A transport that refuses every email.
    pub fn failing() -> Self {
        Self {
            sent: Mutex::new(Vec::new()),
            fail: true,
        }
    }

    /// Every email handed over, in order.
    pub fn sent(&self) -> Vec<OutgoingMail> {
        self.lock().clone()
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> MutexGuard<'_, Vec<OutgoingMail>> {
        self.sent.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl SystemMail for RecordingSystemMail {
    fn send(&self, mail: OutgoingMail) -> impl Future<Output = Result<SentMail, PortError>> + Send {
        let result = if self.fail {
            Err(PortError::backend("RecordingSystemMail is set to fail"))
        } else {
            let mut sent = self.lock();
            sent.push(mail);
            Ok(SentMail {
                message_id: format!("<recording-{}@weldsuite.test>", sent.len()),
                transport: "recording",
                rejected: Vec::new(),
            })
        };
        std::future::ready(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(subject: &str) -> OutgoingMail {
        OutgoingMail {
            from: Mailbox::new("notifications@mail.weldsuite.org").named("WeldSign"),
            to: vec![Mailbox::new("ann@example.com")],
            cc: Vec::new(),
            bcc: Vec::new(),
            reply_to: None,
            subject: subject.to_owned(),
            html: "<p>Hi</p>".to_owned(),
            text: "Hi".to_owned(),
            attachments: Vec::new(),
            headers: Vec::new(),
        }
    }

    #[tokio::test]
    async fn records_through_a_dyn_transport() {
        let recording = Arc::new(RecordingSystemMail::new());
        let transport: Arc<dyn DynSystemMail> = recording.clone();
        let first = transport.send(mail("One")).await.expect("sent");
        transport.send(mail("Two")).await.expect("sent");
        assert_eq!(first.message_id, "<recording-1@weldsuite.test>");
        assert_eq!(
            recording
                .sent()
                .iter()
                .map(|m| m.subject.as_str())
                .collect::<Vec<_>>(),
            ["One", "Two"]
        );
        recording.clear();
        assert_eq!(recording.sent(), Vec::new());
    }

    #[tokio::test]
    async fn a_failing_transport_refuses() {
        assert!(
            RecordingSystemMail::failing()
                .send(mail("x"))
                .await
                .is_err()
        );
    }
}
