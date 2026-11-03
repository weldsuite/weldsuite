//! Customer-mailbox SMTP on the Kubernetes editions: `@weldsuite/smtp`'s
//! `sendMail` (implicit TLS on 465, STARTTLS otherwise, AUTH PLAIN/LOGIN)
//! with lettre, which pods can do directly (Workers needed
//! `cloudflare:sockets`). lettre does not say which command a server refused,
//! so the stage is read from the reply: an auth code (530/534/535) is `auth`,
//! a `5.1.x` or `5.2.1` status is the recipient (`rcpt`), a connection or TLS
//! failure is `connect`, a timeout leaves the delivery uncertain (never
//! retried), anything else is `data`.

use std::time::Duration;

use lettre::address::Envelope;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use weldsuite_ports::BoxFuture;
use weldsuite_reach_domain::smtp::{SmtpConfig, SmtpEnvelope, SmtpSendResult, SmtpTransport};

/// `commandTimeoutMs`'s default.
const TIMEOUT: Duration = Duration::from_secs(30);

/// lettre as the reach SMTP transport.
#[derive(Debug, Default, Clone, Copy)]
pub struct LettreSmtp;

fn failure(stage: &str, response: String, permanent: bool) -> SmtpSendResult {
    SmtpSendResult {
        ok: false,
        response,
        stage: stage.to_owned(),
        permanent,
        recipient_rejected: stage == "rcpt",
        auth_failed: stage == "auth",
        delivery_uncertain: stage == "timeout",
    }
}

/// The stage and permanence of a server's refusal (module docs).
fn classify(error: &lettre::transport::smtp::Error) -> SmtpSendResult {
    let text = error.to_string();
    if error.is_timeout() {
        return failure("timeout", text, true);
    }
    let Some(code) = error.status() else {
        return failure("connect", text, false);
    };
    let code: u16 = code.into();
    let lower = text.to_lowercase();
    if matches!(code, 530 | 534 | 535) {
        return failure("auth", text, true);
    }
    let permanent = (500..600).contains(&code);
    if permanent && (lower.contains("5.1.") || lower.contains("5.2.1")) {
        return failure("rcpt", text, true);
    }
    failure("data", text, permanent)
}

impl SmtpTransport for LettreSmtp {
    fn send(
        &self,
        config: SmtpConfig,
        envelope: SmtpEnvelope,
        raw: String,
    ) -> BoxFuture<'_, Result<SmtpSendResult, String>> {
        Box::pin(async move {
            let builder = if config.secure {
                AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
            } else {
                AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
            };
            let transport = match builder {
                Ok(builder) => builder
                    .port(config.port)
                    .credentials(Credentials::new(
                        config.username.clone(),
                        config.password.clone(),
                    ))
                    .timeout(Some(TIMEOUT))
                    .build(),
                Err(error) => return Ok(failure("connect", error.to_string(), false)),
            };
            let from: Option<Address> = envelope.from.parse().ok();
            let to: Vec<Address> = envelope.to.iter().filter_map(|t| t.parse().ok()).collect();
            let lettre_envelope = match Envelope::new(from, to) {
                Ok(envelope) => envelope,
                Err(error) => return Ok(failure("mail", error.to_string(), true)),
            };
            match transport.send_raw(&lettre_envelope, raw.as_bytes()).await {
                Ok(response) => Ok(SmtpSendResult {
                    ok: true,
                    response: format!(
                        "{} {}",
                        u16::from(response.code()),
                        response.message().collect::<Vec<_>>().join(" ")
                    ),
                    stage: String::new(),
                    permanent: false,
                    recipient_rejected: false,
                    auth_failed: false,
                    delivery_uncertain: false,
                }),
                Err(error) => Ok(classify(&error)),
            }
        })
    }
}
