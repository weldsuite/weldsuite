//! RFC 5322 messages for customer mail (`@weldsuite/email/core/mime`'s
//! `buildRfc5322`): the same headers and part structure as the TypeScript
//! builder (mimetext), built with lettre. Bytes differ between the two (header
//! folding, boundaries, transfer encodings); what a mail client reads does
//! not, and that is what conformance compares (ADR MAIL-010).
//!
//! - From, To, Cc and Reply-To in the headers; Bcc never (blind recipients
//!   are envelope recipients only).
//! - `Message-ID: <32 hex characters@the sender's domain>`, unless given.
//! - `In-Reply-To`, `References` and any other extra header as given.
//! - Text and HTML as `multipart/alternative`; a message with neither gets an
//!   empty text part; attachments around the body in `multipart/mixed`.

use lettre::Message;
use lettre::message::header::{ContentTransferEncoding, ContentType, HeaderName, HeaderValue};
use lettre::message::{Attachment, Body, Mailbox, MultiPart, SinglePart};

/// An address with an optional display name (`EmailAddress`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailAddress {
    pub email: String,
    pub name: Option<String>,
}

impl MailAddress {
    pub fn new(email: impl Into<String>) -> Self {
        Self {
            email: email.into(),
            name: None,
        }
    }

    /// `formatEmailAddress(addr)`: `"Name" <address>` (quotes escaped), or the
    /// bare address.
    pub fn formatted(&self) -> String {
        match self.name.as_deref().filter(|name| !name.is_empty()) {
            Some(name) => format!("\"{}\" <{}>", name.replace('"', "\\\""), self.email),
            None => self.email.clone(),
        }
    }
}

/// A file sent with the message (`EmailAttachment`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MimeAttachment {
    pub filename: String,
    pub content_type: Option<String>,
    pub content: Vec<u8>,
    /// Inline part with this `Content-ID`.
    pub cid: Option<String>,
}

/// What `buildRfc5322` takes (`SendOptions`, the fields mail uses).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MimeMessage {
    pub from: Option<MailAddress>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub reply_to: Option<MailAddress>,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    /// `Message-ID` to use; generated when `None`.
    pub message_id: Option<String>,
    /// Extra headers, in order (`In-Reply-To`, `References`, `Date`, …).
    pub headers: Vec<(String, String)>,
    pub attachments: Vec<MimeAttachment>,
}

/// `BuiltEmail`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltEmail {
    pub raw: Vec<u8>,
    pub message_id: String,
}

/// Why a message could not be built (an address or header lettre refuses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MimeError(pub String);

impl std::fmt::Display for MimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MimeError {}

fn mime_error(error: impl std::fmt::Display) -> MimeError {
    MimeError(error.to_string())
}

/// `generateMessageId(fromEmail)`: `<32 hex@domain>`.
pub fn generate_message_id(from_email: &str) -> String {
    let domain = from_email
        .split('@')
        .nth(1)
        .filter(|_| from_email.contains('@'))
        .unwrap_or("weldmail.local");
    format!("<{}@{domain}>", uuid::Uuid::new_v4().simple())
}

fn mailbox(address: &MailAddress) -> Result<Mailbox, MimeError> {
    let parsed = address.email.trim().parse().map_err(mime_error)?;
    let name = address
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    Ok(Mailbox::new(name, parsed))
}

fn content_type(value: &str) -> ContentType {
    ContentType::parse(value).unwrap_or_else(|_| {
        ContentType::parse("application/octet-stream").unwrap_or(ContentType::TEXT_PLAIN)
    })
}

fn attachment(file: &MimeAttachment) -> SinglePart {
    let kind = content_type(
        file.content_type
            .as_deref()
            .unwrap_or("application/octet-stream"),
    );
    // Base64, as mimetext writes every binary attachment.
    let body = Body::new_with_encoding(file.content.clone(), ContentTransferEncoding::Base64)
        .unwrap_or_else(Body::new);
    match &file.cid {
        Some(cid) => {
            Attachment::new_inline_with_name(cid.clone(), file.filename.clone()).body(body, kind)
        }
        None => Attachment::new(file.filename.clone()).body(body, kind),
    }
}

/// `buildRfc5322(options)`.
pub fn build_rfc5322(message: &MimeMessage) -> Result<BuiltEmail, MimeError> {
    let from = message
        .from
        .as_ref()
        .ok_or_else(|| MimeError("a message needs a sender".to_owned()))?;
    let message_id = message
        .message_id
        .clone()
        .unwrap_or_else(|| generate_message_id(&from.email));
    let mut builder = Message::builder()
        .from(mailbox(from)?)
        .subject(message.subject.clone())
        .message_id(Some(message_id.clone()));
    for to in &message.to {
        builder = builder.to(mailbox(to)?);
    }
    for cc in &message.cc {
        builder = builder.cc(mailbox(cc)?);
    }
    if let Some(reply_to) = &message.reply_to {
        builder = builder.reply_to(mailbox(reply_to)?);
    }

    let text = message.text.as_deref().filter(|t| !t.is_empty());
    let html = message.html.as_deref().filter(|h| !h.is_empty());
    let body: Option<MultiPart> = match (text, html) {
        (Some(text), Some(html)) => Some(
            MultiPart::alternative()
                .singlepart(SinglePart::plain(text.to_owned()))
                .singlepart(SinglePart::html(html.to_owned())),
        ),
        _ => None,
    };
    let single = match (text, html) {
        (Some(_), Some(_)) => None,
        (None, Some(html)) => Some(SinglePart::html(html.to_owned())),
        (text, None) => Some(SinglePart::plain(text.unwrap_or_default().to_owned())),
    };

    let mut built = if message.attachments.is_empty() {
        match (body, single) {
            (Some(body), _) => builder.multipart(body),
            (None, Some(single)) => builder.singlepart(single),
            (None, None) => builder.body(String::new()),
        }
    } else {
        let mut mixed = match (body, single) {
            (Some(body), _) => MultiPart::mixed().multipart(body),
            (None, Some(single)) => MultiPart::mixed().singlepart(single),
            (None, None) => MultiPart::mixed().singlepart(SinglePart::plain(String::new())),
        };
        for file in &message.attachments {
            mixed = mixed.singlepart(attachment(file));
        }
        builder.multipart(mixed)
    }
    .map_err(mime_error)?;

    for (name, value) in &message.headers {
        let name = HeaderName::new_from_ascii(name.clone()).map_err(mime_error)?;
        built
            .headers_mut()
            .insert_raw(HeaderValue::new(name, value.clone()));
    }
    Ok(BuiltEmail {
        raw: built.formatted(),
        message_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(message: &MimeMessage) -> String {
        String::from_utf8(build_rfc5322(message).expect("built").raw).expect("utf-8")
    }

    fn base() -> MimeMessage {
        MimeMessage {
            from: Some(MailAddress {
                email: "tom@acme.com".to_owned(),
                name: Some("Tom Ä".to_owned()),
            }),
            to: vec![MailAddress::new("a@x.com"), MailAddress::new("b@y.com")],
            cc: vec![MailAddress::new("c@z.com")],
            reply_to: Some(MailAddress::new("r@acme.com")),
            subject: "Héllo there".to_owned(),
            text: Some("Hi there\nline2".to_owned()),
            html: Some("<p>Hi</p>".to_owned()),
            message_id: None,
            headers: vec![
                ("In-Reply-To".to_owned(), "<p@x>".to_owned()),
                ("References".to_owned(), "<a@x> <p@x>".to_owned()),
            ],
            attachments: vec![MimeAttachment {
                filename: "a.pdf".to_owned(),
                content_type: Some("application/pdf".to_owned()),
                content: vec![1, 2, 3],
                cid: None,
            }],
        }
    }

    #[test]
    fn builds_the_headers_and_parts_mimetext_does() {
        let built = build_rfc5322(&base()).expect("built");
        let text = String::from_utf8(built.raw.clone()).expect("utf-8");
        assert!(built.message_id.ends_with("@acme.com>"));
        assert_eq!(built.message_id.len(), "<@acme.com>".len() + 32);
        assert!(text.contains(&format!("Message-ID: {}", built.message_id)));
        assert!(text.contains("In-Reply-To: <p@x>"));
        assert!(text.contains("References: <a@x> <p@x>"));
        assert!(text.contains("Reply-To: r@acme.com"));
        assert!(text.contains("multipart/mixed"));
        assert!(text.contains("multipart/alternative"));
        assert!(text.contains("filename=\"a.pdf\""));
        assert!(text.contains("Date: "));
        assert!(text.contains("<p@x>"));
    }

    #[test]
    fn single_parts_and_empty_bodies() {
        let text_only = MimeMessage {
            html: None,
            attachments: Vec::new(),
            ..base()
        };
        let raw_text = raw(&text_only);
        assert!(!raw_text.contains("multipart"));
        assert!(raw_text.contains("text/plain"));
        let empty = MimeMessage {
            text: None,
            html: None,
            attachments: Vec::new(),
            ..base()
        };
        assert!(raw(&empty).contains("text/plain"));
        let html_only = MimeMessage {
            text: None,
            attachments: Vec::new(),
            ..base()
        };
        assert!(raw(&html_only).contains("text/html"));
    }

    #[test]
    fn keeps_a_given_message_id_and_formats_senders() {
        let fixed = MimeMessage {
            message_id: Some("<fixed@acme.com>".to_owned()),
            ..base()
        };
        assert_eq!(
            build_rfc5322(&fixed).expect("built").message_id,
            "<fixed@acme.com>"
        );
        assert_eq!(
            MailAddress {
                email: "t@a.com".to_owned(),
                name: Some("Tom \"T\"".to_owned())
            }
            .formatted(),
            "\"Tom \\\"T\\\"\" <t@a.com>"
        );
        assert_eq!(MailAddress::new("t@a.com").formatted(), "t@a.com");
        assert_eq!(
            generate_message_id("nobody").len(),
            "<@weldmail.local>".len() + 32
        );
    }
}
