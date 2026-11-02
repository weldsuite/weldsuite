//! System mail over SMTP (`SystemMail`), replacing the Cloudflare `SEND_EMAIL`
//! binding. Any SMTP relay works: Postfix, Stalwart, a provider's relay
//! (Brevo, Mailjet, Scaleway TEM), Mailpit in tests.
//!
//! Configured by one URL, as lettre reads it:
//!
//! - `smtp://user:password@relay.example.com:587?tls=required`: STARTTLS,
//!   refused when the server does not offer it
//! - `smtps://user:password@relay.example.com:465`: TLS from the first byte
//! - `smtp://mailpit:1025`: plain, for a relay inside the cluster or tests
//!
//! Certificates are checked against the system's roots
//! (`rustls-platform-verifier`).

use lettre::message::header::{ContentType, HeaderName, HeaderValue};
use lettre::message::{Attachment, Mailbox as LettreMailbox, MultiPart, SinglePart};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use weldsuite_ports::{Mailbox, OutgoingMail, PortError, SentMail, SystemMail};

/// An SMTP relay.
#[derive(Clone)]
pub struct SmtpMail {
    transport: AsyncSmtpTransport<Tokio1Executor>,
}

impl std::fmt::Debug for SmtpMail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpMail").finish_non_exhaustive()
    }
}

impl SmtpMail {
    /// A relay from its URL (see the module docs). Connects lazily, on the
    /// first send, through a small connection pool, whose upkeep task needs a
    /// Tokio runtime: call this inside one.
    pub fn from_url(url: &str) -> Result<Self, PortError> {
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url)
            .map_err(PortError::backend)?
            .build();
        Ok(Self { transport })
    }

    /// Whether the relay answers (`NOOP`), for a readiness check.
    pub async fn test_connection(&self) -> Result<bool, PortError> {
        self.transport
            .test_connection()
            .await
            .map_err(PortError::backend)
    }
}

fn mailbox(mailbox: &Mailbox) -> Result<LettreMailbox, PortError> {
    let address = mailbox.email.trim().parse().map_err(PortError::backend)?;
    // `formatMailbox`: drop what breaks a header from the display name.
    let name = mailbox
        .name
        .as_deref()
        .map(|n| n.replace(['"', '\\', '<', '>', '\r', '\n'], ""))
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty());
    Ok(LettreMailbox::new(name, address))
}

/// The MIME message: text and HTML as alternatives, attachments around them.
fn message(mail: &OutgoingMail) -> Result<Message, PortError> {
    let mut builder = Message::builder()
        .from(mailbox(&mail.from)?)
        .subject(mail.subject.clone());
    for to in &mail.to {
        builder = builder.to(mailbox(to)?);
    }
    for cc in &mail.cc {
        builder = builder.cc(mailbox(cc)?);
    }
    for bcc in &mail.bcc {
        builder = builder.bcc(mailbox(bcc)?);
    }
    if let Some(reply_to) = &mail.reply_to {
        builder = builder.reply_to(mailbox(reply_to)?);
    }

    let body = MultiPart::alternative()
        .singlepart(SinglePart::plain(mail.text.clone()))
        .singlepart(SinglePart::html(mail.html.clone()));
    let mut message = if mail.attachments.is_empty() {
        builder.multipart(body)
    } else {
        let mut mixed = MultiPart::mixed().multipart(body);
        for file in &mail.attachments {
            let content_type =
                ContentType::parse(&file.content_type).map_err(PortError::backend)?;
            mixed = mixed.singlepart(
                Attachment::new(file.filename.clone()).body(file.content.clone(), content_type),
            );
        }
        builder.multipart(mixed)
    }
    .map_err(PortError::backend)?;

    for (name, value) in &mail.headers {
        let name = HeaderName::new_from_ascii(name.clone()).map_err(PortError::backend)?;
        message
            .headers_mut()
            .insert_raw(HeaderValue::new(name, value.clone()));
    }
    Ok(message)
}

impl SystemMail for SmtpMail {
    fn send(&self, mail: OutgoingMail) -> impl Future<Output = Result<SentMail, PortError>> + Send {
        let transport = self.transport.clone();
        async move {
            let message = message(&mail)?;
            let message_id = message
                .headers()
                .get_raw("Message-ID")
                .map(str::to_owned)
                .unwrap_or_default();
            transport.send(message).await.map_err(PortError::backend)?;
            Ok(SentMail {
                message_id,
                transport: "smtp",
                rejected: Vec::new(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use weldsuite_ports::MailAttachment;

    use super::*;

    fn sample() -> OutgoingMail {
        OutgoingMail {
            from: Mailbox::new("notifications@mail.weldsuite.org").named("Acme \"Staffing\" <x>"),
            to: vec![Mailbox::new("ann@example.com").named("Ann")],
            cc: Vec::new(),
            bcc: vec![Mailbox::new("audit@example.com")],
            reply_to: Some(Mailbox::new("gert@example.com")),
            subject: "Gert sent you \"NDA\" to sign".to_owned(),
            html: "<p>Hi</p>".to_owned(),
            text: "Hi".to_owned(),
            attachments: vec![MailAttachment {
                filename: "NDA.pdf".to_owned(),
                content_type: "application/pdf".to_owned(),
                content: b"%PDF-1.7".to_vec(),
            }],
            headers: vec![("X-Weld-Template".to_owned(), "sign.request".to_owned())],
        }
    }

    #[test]
    fn builds_the_mime_message() {
        let raw =
            String::from_utf8(message(&sample()).expect("message").formatted()).expect("utf-8");
        assert!(raw.contains("From: \"Acme Staffing x\" <notifications@mail.weldsuite.org>"));
        assert!(
            raw.contains("To: \"Ann\" <ann@example.com>")
                || raw.contains("To: Ann <ann@example.com>")
        );
        assert!(raw.contains("Reply-To: gert@example.com"));
        assert!(raw.contains("X-Weld-Template: sign.request"));
        assert!(raw.contains("multipart/alternative"));
        assert!(raw.contains("multipart/mixed"));
        assert!(raw.contains("filename=\"NDA.pdf\""));
        // Bcc never reaches the headers.
        assert!(!raw.contains("audit@example.com"));
    }

    #[tokio::test]
    async fn urls_are_checked() {
        assert!(SmtpMail::from_url("smtp://mailpit:1025").is_ok());
        assert!(SmtpMail::from_url("smtps://u:p@relay.example.com:465").is_ok());
        assert!(SmtpMail::from_url("http://nope").is_err());
    }

    /// Against a real relay (Mailpit in CI and kind) when
    /// `WELDSUITE_TEST_SMTP_URL` is set, e.g. `smtp://127.0.0.1:1025`.
    #[tokio::test]
    async fn sends_through_a_relay() {
        let Ok(url) = std::env::var("WELDSUITE_TEST_SMTP_URL") else {
            return;
        };
        let smtp = SmtpMail::from_url(&url).expect("url");
        assert!(smtp.test_connection().await.expect("connection"));
        let sent = smtp.send(sample()).await.expect("sent");
        assert_eq!(sent.transport, "smtp");
    }
}
