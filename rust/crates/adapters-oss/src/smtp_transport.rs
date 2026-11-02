//! Customer mail over SMTP submission (`MailTransport`), replacing the
//! Cloudflare `SEND_EMAIL` binding for WeldMail and every other send path of
//! user-written mail (ADR MAIL-010). Same relay URL format as system mail
//! ([`crate::SmtpMail`]), but its own URL and credentials: customer mail goes
//! out under a separate identity of the relay, so a workspace's sending
//! cannot hurt WeldSuite's own mail.
//!
//! One SMTP transaction per envelope recipient, with the message built once
//! by the caller, as the binding takes one recipient per `EmailMessage`. The
//! relay's refusals are mapped onto the Cloudflare codes the send path acts
//! on, by enhanced status code (RFC 3463) and reply text:
//!
//! | Relay answer | Code |
//! |---|---|
//! | 4.7.x, or a 4xx naming a rate or limit | `E_RATE_LIMIT_EXCEEDED` (a daily quota: `E_DAILY_LIMIT_EXCEEDED`) |
//! | 5.1.x (bad or unknown mailbox), 5.2.1 (mailbox disabled) | `E_RECIPIENT_SUPPRESSED`: skipped, the others still get it |
//! | 5.7.x on the sender (not authorised, domain not verified) | `E_SENDER_NOT_VERIFIED` |
//! | anything else | none: a plain failure that ends the send |

use std::sync::LazyLock;

use lettre::address::Envelope as LettreEnvelope;
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use weldsuite_ports::{BoxFuture, Envelope, MailTransport, PortError, TransportFailure};

/// SMTP submission to a relay, for customer mail.
#[derive(Clone)]
pub struct SmtpMailTransport {
    transport: AsyncSmtpTransport<Tokio1Executor>,
}

impl std::fmt::Debug for SmtpMailTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpMailTransport").finish_non_exhaustive()
    }
}

impl SmtpMailTransport {
    /// A relay from its URL (`smtp://user:password@relay:587?tls=required`,
    /// `smtps://…:465`, `smtp://mailpit:1025`). Connects lazily; call inside
    /// a Tokio runtime.
    pub fn from_url(url: &str) -> Result<Self, PortError> {
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url)
            .map_err(PortError::backend)?
            .build();
        Ok(Self { transport })
    }
}

static ENHANCED: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?-u:\b)([245])\.([0-9]{1,3})\.([0-9]{1,3})(?-u:\b)")
        .unwrap_or_else(|error| panic!("bad pattern: {error}"))
});

/// The Cloudflare code for a relay's answer (see the module docs).
pub fn refusal_code(permanent: bool, text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    let enhanced = ENHANCED
        .captures(&lower)
        .map(|caps| (caps[1].to_owned(), caps[2].to_owned(), caps[3].to_owned()));
    let class = enhanced
        .as_ref()
        .map(|(class, subject, _)| (class.as_str(), subject.as_str()));
    let names_limit = ["rate", "limit", "too many", "quota", "throttl"]
        .iter()
        .any(|word| lower.contains(word));
    if !permanent {
        if lower.contains("daily") && names_limit {
            return Some("E_DAILY_LIMIT_EXCEEDED");
        }
        if matches!(class, Some(("4", "7"))) || names_limit {
            return Some("E_RATE_LIMIT_EXCEEDED");
        }
        return None;
    }
    match (
        class,
        enhanced.as_ref().map(|(_, _, detail)| detail.as_str()),
    ) {
        (Some(("5", "1")), _) | (Some(("5", "2")), Some("1")) => Some("E_RECIPIENT_SUPPRESSED"),
        (Some(("5", "7")), _)
            if ["sender", "from", "domain", "not authori", "relay"]
                .iter()
                .any(|word| lower.contains(word)) =>
        {
            Some("E_SENDER_NOT_VERIFIED")
        }
        _ if lower.contains("daily") && names_limit => Some("E_DAILY_LIMIT_EXCEEDED"),
        _ => None,
    }
}

fn address(value: &str) -> Result<Address, TransportFailure> {
    value
        .trim()
        .parse()
        .map_err(|error| TransportFailure::new(None, format!("invalid address {value}: {error}")))
}

impl MailTransport for SmtpMailTransport {
    fn send<'a>(
        &'a self,
        envelope: &'a Envelope,
        raw: &'a [u8],
    ) -> BoxFuture<'a, Result<(), TransportFailure>> {
        Box::pin(async move {
            let from = address(envelope.mail_from())?;
            let to = address(&envelope.to)?;
            let lettre_envelope = LettreEnvelope::new(Some(from), vec![to])
                .map_err(|error| TransportFailure::new(None, error.to_string()))?;
            self.transport
                .send_raw(&lettre_envelope, raw)
                .await
                .map(|_| ())
                .map_err(|error| {
                    let text = error.to_string();
                    let code = refusal_code(error.is_permanent(), &text);
                    TransportFailure::new(code, text)
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_relay_answers_to_cloudflare_codes() {
        assert_eq!(
            refusal_code(true, "permanent error (550): 5.1.1 <x@y.com>: user unknown"),
            Some("E_RECIPIENT_SUPPRESSED")
        );
        assert_eq!(
            refusal_code(
                true,
                "permanent error (553): 5.7.1 sender address not authorised"
            ),
            Some("E_SENDER_NOT_VERIFIED")
        );
        assert_eq!(
            refusal_code(
                false,
                "transient error (421): 4.7.0 too many messages, slow down"
            ),
            Some("E_RATE_LIMIT_EXCEEDED")
        );
        assert_eq!(
            refusal_code(false, "transient error (452): daily sending quota exceeded"),
            Some("E_DAILY_LIMIT_EXCEEDED")
        );
        assert_eq!(refusal_code(false, "connection reset"), None);
        assert_eq!(
            refusal_code(true, "permanent error (554): 5.6.0 bad message"),
            None
        );
    }

    #[tokio::test]
    async fn urls_are_checked() {
        assert!(SmtpMailTransport::from_url("smtp://mailpit:1025").is_ok());
        assert!(SmtpMailTransport::from_url("http://nope").is_err());
    }

    /// Against a real relay (Mailpit) when `WELDSUITE_TEST_SMTP_URL` is set.
    #[tokio::test]
    async fn sends_through_a_relay() {
        let Ok(url) = std::env::var("WELDSUITE_TEST_SMTP_URL") else {
            return;
        };
        let transport = SmtpMailTransport::from_url(&url).expect("url");
        let raw = b"From: tom@acme.com\r\nTo: a@x.com\r\nSubject: Hi\r\nMessage-ID: <t@acme.com>\r\n\r\nHello\r\n";
        transport
            .send(
                &Envelope {
                    from: "\"Tom\" <tom@acme.com>".to_owned(),
                    to: "a@x.com".to_owned(),
                },
                raw,
            )
            .await
            .expect("sent");
    }
}
