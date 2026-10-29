//! `sendSystemEmail` (`packages/core/emails/src/send.ts`) and
//! `withFromAddress`.

use std::sync::Arc;

use weldsuite_ports::{
    BoxFuture, DynSystemMail, MailAttachment, Mailbox, OutgoingMail, PortError, SentMail,
};

use crate::{EmailBrand, RenderedEmail};

/// The one address every system email is sent from. The display name varies
/// (module, workspace); replies that should reach a person go through
/// Reply-To.
pub const SYSTEM_FROM_ADDRESS: &str = "notifications@mail.weldsuite.org";

/// What to send: a rendered email and its envelope (`SendSystemEmailOptions`).
#[derive(Debug, Clone)]
pub struct SystemEmail {
    pub rendered: RenderedEmail,
    /// The brand it was rendered with: the From display name.
    pub brand: EmailBrand,
    /// Overrides the brand's sender name.
    pub from_name: Option<String>,
    pub to: Vec<Mailbox>,
    pub cc: Vec<Mailbox>,
    pub bcc: Vec<Mailbox>,
    pub reply_to: Option<Mailbox>,
    pub attachments: Vec<MailAttachment>,
    pub headers: Vec<(String, String)>,
}

impl SystemEmail {
    /// One recipient, no Reply-To or attachments.
    pub fn to(rendered: RenderedEmail, brand: EmailBrand, to: &str) -> Self {
        Self {
            rendered,
            brand,
            from_name: None,
            to: vec![Mailbox::new(to)],
            cc: Vec::new(),
            bcc: Vec::new(),
            reply_to: None,
            attachments: Vec::new(),
            headers: Vec::new(),
        }
    }

    #[must_use]
    pub fn reply_to(mut self, address: Option<&str>) -> Self {
        self.reply_to = address
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(Mailbox::new);
        self
    }

    #[must_use]
    pub fn attach(mut self, attachment: MailAttachment) -> Self {
        self.attachments.push(attachment);
        self
    }
}

fn trimmed(list: Vec<Mailbox>) -> Vec<Mailbox> {
    list.into_iter()
        .map(|m| Mailbox {
            email: m.email.trim().to_owned(),
            name: m.name,
        })
        .filter(|m| !m.email.is_empty())
        .collect()
}

/// Hand a rendered email to the transport (`sendSystemEmail`), from
/// [`SYSTEM_FROM_ADDRESS`] under the brand's name. Fails when there is no
/// recipient or the transport refuses; most callers log and go on, as mail
/// is best effort.
pub async fn send_system_email(
    transport: &dyn DynSystemMail,
    email: SystemEmail,
) -> Result<SentMail, PortError> {
    let to = trimmed(email.to);
    let cc = trimmed(email.cc);
    let bcc = trimmed(email.bcc);
    if to.is_empty() && cc.is_empty() && bcc.is_empty() {
        return Err(PortError::backend("send_system_email: no recipients"));
    }
    let from_name = email
        .from_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| email.brand.sender_name())
        .to_owned();
    let mail = OutgoingMail {
        from: Mailbox::new(SYSTEM_FROM_ADDRESS).named(from_name),
        to,
        cc,
        bcc,
        reply_to: email.reply_to.map(|m| Mailbox {
            email: m.email.trim().to_owned(),
            name: m.name,
        }),
        subject: email.rendered.subject,
        html: email.rendered.html,
        text: email.rendered.text,
        attachments: email.attachments,
        headers: email.headers,
    };
    transport.send_boxed(mail).await
}

/// Sends from another address than [`SYSTEM_FROM_ADDRESS`]
/// (`withFromAddress`, `SYSTEM_EMAIL_FROM`): a deployment whose relay only
/// accepts its own domain.
pub struct WithFromAddress {
    inner: Arc<dyn DynSystemMail>,
    address: String,
}

impl WithFromAddress {
    /// `inner` itself when `address` is empty.
    pub fn wrap(inner: Arc<dyn DynSystemMail>, address: Option<&str>) -> Arc<dyn DynSystemMail> {
        match address.map(str::trim).filter(|a| !a.is_empty()) {
            Some(address) => Arc::new(Self {
                inner,
                address: address.to_owned(),
            }),
            None => inner,
        }
    }
}

impl DynSystemMail for WithFromAddress {
    fn send_boxed(&self, mut mail: OutgoingMail) -> BoxFuture<'_, Result<SentMail, PortError>> {
        mail.from.email.clone_from(&self.address);
        self.inner.send_boxed(mail)
    }
}

#[cfg(test)]
mod tests {
    use weldsuite_ports::RecordingSystemMail;

    use super::*;

    fn rendered() -> RenderedEmail {
        RenderedEmail {
            subject: "Hi".to_owned(),
            html: "<p>Hi</p>".to_owned(),
            text: "Hi".to_owned(),
        }
    }

    #[tokio::test]
    async fn sends_from_the_system_address_under_the_brand() {
        let recording = Arc::new(RecordingSystemMail::new());
        let brand = EmailBrand::Workspace {
            name: "Acme".to_owned(),
            logo_url: None,
            accent_color: None,
        };
        let email = SystemEmail::to(rendered(), brand, " ann@example.com ")
            .reply_to(Some("gert@example.com"));
        send_system_email(&*recording, email).await.expect("sent");
        let sent = recording.sent();
        assert_eq!(
            sent[0].from,
            Mailbox::new(SYSTEM_FROM_ADDRESS).named("Acme")
        );
        assert_eq!(sent[0].to, vec![Mailbox::new("ann@example.com")]);
        assert_eq!(sent[0].reply_to, Some(Mailbox::new("gert@example.com")));
    }

    #[tokio::test]
    async fn needs_a_recipient_and_honours_the_from_override() {
        let recording = Arc::new(RecordingSystemMail::new());
        let brand = EmailBrand::weldsuite("WeldSign");
        let nobody = SystemEmail::to(rendered(), brand.clone(), "  ");
        assert!(send_system_email(&*recording, nobody).await.is_err());

        let transport = WithFromAddress::wrap(recording.clone(), Some("mail@eu.example"));
        let email = SystemEmail::to(rendered(), brand, "ann@example.com");
        send_system_email(&*transport, email).await.expect("sent");
        assert_eq!(
            recording.sent()[0].from,
            Mailbox::new("mail@eu.example").named("WeldSign")
        );
    }
}
