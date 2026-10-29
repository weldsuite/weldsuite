//! Handing a customer message to the transport (`sendEmail` of
//! `@weldsuite/worker-email` over `CloudflareSendProvider.send`): the message
//! is built once and given to one envelope per recipient, so every copy
//! shares one Message-ID and the same To/Cc headers (a reply-all lands as one
//! message to the group). A recipient that needs verifying or that the relay
//! suppressed is noted and skipped; any other refusal ends the send and
//! carries the recipients that already got it.

use weldsuite_ports::{Envelope, MailTransport};

use super::guard::SentRecipients;
use super::mime::{MailAddress, MimeAttachment, MimeMessage, build_rfc5322};

/// The relay's cap on `to` + `cc` + `bcc` for one message.
pub const MAX_RECIPIENTS: usize = 50;

/// `ProviderRefusal`: why the relay refused, when it says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    RateLimited,
    DailyLimit,
    RecipientSuppressed,
    SenderNotAllowed,
}

/// `refusalOf(err)`: Cloudflare's codes we act on.
fn refusal_of(code: Option<&str>) -> Option<Refusal> {
    match code? {
        "E_RATE_LIMIT_EXCEEDED" => Some(Refusal::RateLimited),
        "E_DAILY_LIMIT_EXCEEDED" => Some(Refusal::DailyLimit),
        "E_RECIPIENT_SUPPRESSED" => Some(Refusal::RecipientSuppressed),
        "E_SENDER_NOT_VERIFIED" | "E_SENDER_DOMAIN_NOT_AVAILABLE" => {
            Some(Refusal::SenderNotAllowed)
        }
        _ => None,
    }
}

/// Why a send failed (`ProviderConfigError`, `TransientProviderError`,
/// `ProviderRefusedError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransmitError {
    /// Nothing to send, too many recipients, or a message that can't be built.
    Config(String),
    /// A plain failure on one envelope.
    Transient {
        message: String,
        sent_recipients: Vec<String>,
        message_id: Option<String>,
    },
    /// The relay refused, saying why.
    Refused {
        refusal: Refusal,
        recipient: String,
        message: String,
        sent_recipients: Vec<String>,
        message_id: Option<String>,
    },
}

impl TransmitError {
    pub fn message_id(&self) -> Option<&str> {
        match self {
            Self::Config(_) => None,
            Self::Transient { message_id, .. } | Self::Refused { message_id, .. } => {
                message_id.as_deref()
            }
        }
    }
}

impl SentRecipients for TransmitError {
    fn sent_recipients(&self) -> &[String] {
        match self {
            Self::Config(_) => &[],
            Self::Transient {
                sent_recipients, ..
            }
            | Self::Refused {
                sent_recipients, ..
            } => sent_recipients,
        }
    }
}

impl std::fmt::Display for TransmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(message)
            | Self::Transient { message, .. }
            | Self::Refused { message, .. } => f.write_str(message),
        }
    }
}

impl std::error::Error for TransmitError {}

/// `SendEmailParams`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendEmailParams {
    /// `Name <address>` or a bare address.
    pub from: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub reply_to: Option<String>,
    /// Extra headers, in order.
    pub headers: Vec<(String, String)>,
    pub attachments: Vec<MimeAttachment>,
}

/// `SendEmailResponse`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendEmailResponse {
    pub message_id: String,
    /// A recipient has to verify before delivery; the rest went out.
    pub pending_verification: bool,
    /// Recipients the relay skipped because they are on its suppression list.
    pub suppressed_recipients: Vec<String>,
}

/// `/^"?([^"<]*)(?:"\s*)?<([^>]+)>$/` on the From value.
fn parse_from(from: &str) -> MailAddress {
    let parsed = from
        .strip_suffix('>')
        .and_then(|rest| rest.rsplit_once('<'))
        .and_then(|(head, address)| {
            if address.contains('>') || address.is_empty() {
                return None;
            }
            let head = head.strip_prefix('"').unwrap_or(head);
            let name = head.trim_end().strip_suffix('"').map_or(head, |name| name);
            if name.contains('"') || name.contains('<') {
                return None;
            }
            Some(MailAddress {
                email: address.trim().to_owned(),
                name: Some(name.trim().to_owned()).filter(|n| !n.is_empty()),
            })
        });
    parsed.unwrap_or_else(|| MailAddress::new(from.trim()))
}

/// `sendEmail(env, params)`: build the message once and send one envelope per
/// recipient.
pub async fn send_email(
    transport: &dyn MailTransport,
    params: &SendEmailParams,
) -> Result<SendEmailResponse, TransmitError> {
    let recipients: Vec<&String> = params
        .to
        .iter()
        .chain(&params.cc)
        .chain(&params.bcc)
        .collect();
    if recipients.is_empty() {
        return Err(TransmitError::Config("sendEmail: no recipients".to_owned()));
    }
    if recipients.len() > MAX_RECIPIENTS {
        return Err(TransmitError::Config(format!(
            "Provider \"cloudflare\" missing config: send() called with {} recipients; at most {MAX_RECIPIENTS} across to/cc/bcc",
            recipients.len()
        )));
    }
    let from = parse_from(&params.from);
    let built = build_rfc5322(&MimeMessage {
        from: Some(from.clone()),
        to: params.to.iter().map(MailAddress::new).collect(),
        cc: params.cc.iter().map(MailAddress::new).collect(),
        reply_to: params.reply_to.as_ref().map(MailAddress::new),
        subject: params.subject.clone(),
        text: params.text.clone(),
        html: params.html.clone(),
        message_id: None,
        headers: params.headers.clone(),
        attachments: params.attachments.clone(),
    })
    .map_err(|error| TransmitError::Config(error.to_string()))?;
    let envelope_from = from.formatted();

    let mut sent = Vec::new();
    let mut pending = Vec::new();
    let mut suppressed = Vec::new();
    for rcpt in recipients {
        let envelope = Envelope {
            from: envelope_from.clone(),
            to: rcpt.clone(),
        };
        let Err(failure) = transport.send(&envelope, &built.raw).await else {
            sent.push(rcpt.clone());
            continue;
        };
        if failure.code.as_deref() == Some("E_RECIPIENT_NOT_ALLOWED") {
            pending.push(rcpt.clone());
            continue;
        }
        let refusal = refusal_of(failure.code.as_deref());
        if refusal == Some(Refusal::RecipientSuppressed) {
            suppressed.push(rcpt.clone());
            continue;
        }
        let described = match &failure.code {
            Some(code) => format!("Error ({code}) {}", failure.message),
            None => format!("Error {}", failure.message),
        };
        let message = format!("send_email failed for {rcpt}: {}", described.trim());
        return Err(match refusal {
            Some(refusal) => TransmitError::Refused {
                refusal,
                recipient: rcpt.clone(),
                message,
                sent_recipients: sent,
                message_id: Some(built.message_id),
            },
            None => TransmitError::Transient {
                message,
                sent_recipients: sent,
                message_id: Some(built.message_id),
            },
        });
    }
    if sent.is_empty() && pending.is_empty() && !suppressed.is_empty() {
        return Err(TransmitError::Refused {
            refusal: Refusal::RecipientSuppressed,
            recipient: suppressed[0].clone(),
            message: format!(
                "send_email refused: every recipient is suppressed ({})",
                suppressed.join(", ")
            ),
            sent_recipients: Vec::new(),
            message_id: Some(built.message_id),
        });
    }
    Ok(SendEmailResponse {
        message_id: built.message_id,
        pending_verification: !pending.is_empty(),
        suppressed_recipients: suppressed,
    })
}

#[cfg(test)]
mod tests {
    use weldsuite_ports::RecordingMailTransport;

    use super::*;

    fn params(to: &[&str]) -> SendEmailParams {
        SendEmailParams {
            from: "Tom Jansen <tom@acme.com>".to_owned(),
            to: to.iter().map(|s| (*s).to_owned()).collect(),
            subject: "Hello".to_owned(),
            text: Some("Hi".to_owned()),
            ..SendEmailParams::default()
        }
    }

    #[test]
    fn parses_from_like_the_worker() {
        assert_eq!(
            parse_from("Tom Jansen <tom@acme.com>"),
            MailAddress {
                email: "tom@acme.com".to_owned(),
                name: Some("Tom Jansen".to_owned())
            }
        );
        assert_eq!(
            parse_from("\"Tom\" <tom@acme.com>").name.as_deref(),
            Some("Tom")
        );
        assert_eq!(parse_from("<tom@acme.com>").name, None);
        assert_eq!(parse_from("tom@acme.com"), MailAddress::new("tom@acme.com"));
    }

    #[tokio::test]
    async fn one_message_one_envelope_per_recipient() {
        let transport = RecordingMailTransport::new();
        let mut p = params(&["a@x.com"]);
        p.cc = vec!["c@x.com".to_owned()];
        p.bcc = vec!["b@x.com".to_owned()];
        let sent = send_email(&transport, &p).await.expect("sent");
        let envelopes = transport.sent();
        assert_eq!(envelopes.len(), 3);
        assert!(envelopes.iter().all(|e| e.raw == envelopes[0].raw));
        assert_eq!(envelopes[0].envelope.from, "\"Tom Jansen\" <tom@acme.com>");
        assert_eq!(
            envelopes
                .iter()
                .map(|e| e.envelope.to.as_str())
                .collect::<Vec<_>>(),
            ["a@x.com", "c@x.com", "b@x.com"]
        );
        let raw = String::from_utf8(envelopes[0].raw.clone()).expect("utf-8");
        assert!(raw.contains(&sent.message_id));
        assert!(!raw.contains("b@x.com"), "Bcc stays out of the headers");
        assert!(!sent.pending_verification);
    }

    #[tokio::test]
    async fn skips_pending_and_suppressed_recipients() {
        let transport = RecordingMailTransport::new()
            .refuse("p@x.com", Some("E_RECIPIENT_NOT_ALLOWED"))
            .refuse("s@x.com", Some("E_RECIPIENT_SUPPRESSED"));
        let sent = send_email(&transport, &params(&["a@x.com", "p@x.com", "s@x.com"]))
            .await
            .expect("sent");
        assert!(sent.pending_verification);
        assert_eq!(sent.suppressed_recipients, ["s@x.com"]);
        let all_suppressed =
            RecordingMailTransport::new().refuse("s@x.com", Some("E_RECIPIENT_SUPPRESSED"));
        let refused = send_email(&all_suppressed, &params(&["s@x.com"]))
            .await
            .expect_err("refused");
        assert!(matches!(
            refused,
            TransmitError::Refused {
                refusal: Refusal::RecipientSuppressed,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn a_failure_ends_the_send_with_who_already_got_it() {
        let transport = RecordingMailTransport::new()
            .refuse("b@x.com", Some("E_DAILY_LIMIT_EXCEEDED"))
            .refuse("z@x.com", None);
        let refused = send_email(&transport, &params(&["a@x.com", "b@x.com", "c@x.com"]))
            .await
            .expect_err("refused");
        assert_eq!(refused.sent_recipients(), ["a@x.com"]);
        assert!(matches!(
            refused,
            TransmitError::Refused {
                refusal: Refusal::DailyLimit,
                ..
            }
        ));
        assert!(refused.message_id().is_some());
        let failed = send_email(&transport, &params(&["z@x.com"]))
            .await
            .expect_err("failed");
        assert!(matches!(failed, TransmitError::Transient { .. }));
        assert!(
            send_email(&transport, &params(&[]))
                .await
                .is_err_and(|e| e.to_string() == "sendEmail: no recipients")
        );
    }
}
