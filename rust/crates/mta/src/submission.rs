//! The submission policy (port 2587, private network): the server and
//! `weldsuite consume`/`cron` hand mail over here through `SMTP_URL`
//! (pool `system`) and `MAIL_SMTP_URL` (pool `customer`).
//!
//! Answers are chosen so the server's SMTP transport
//! (`crates/adapters-oss/src/smtp_transport.rs`) maps them onto the
//! Cloudflare codes the send path acts on:
//!
//! | Situation | Reply | Code |
//! |---|---|---|
//! | recipient hard-bounced or complained in this pool recently | `550 5.1.1 recipient suppressed` | `E_RECIPIENT_SUPPRESSED` |
//! | no DKIM key covers the sender's domain for this pool | `550 5.7.1 sender domain not authorised` | `E_SENDER_NOT_VERIFIED` |
//! | the database cannot be reached | `451 4.3.0` | a plain failure, retried |
//!
//! `250` only after the message and its recipients are committed. The MSA
//! fixes what RFC 6409 §8 lets it: `Bcc` is removed, a missing `Date` or
//! `Message-ID` is added.

use std::collections::BTreeMap;
use std::sync::Arc;

use tokio_rustls::TlsAcceptor;

use crate::BoxFuture;
use crate::crypto::new_id;
use crate::domains::Signers;
use crate::message::{self, domain_of, first_address};
use crate::smtp::Reply;
use crate::smtp::server::{Policy, SessionInfo, Transaction};
use crate::store::Store;

pub struct Submission {
    pub hostname: String,
    pub max_message_bytes: usize,
    pub tls: Option<std::sync::Arc<crate::tls::Reloading>>,
    /// pool → password.
    pub passwords: BTreeMap<String, String>,
    pub store: Store,
    pub signers: Arc<Signers>,
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn unavailable() -> Reply {
    Reply::new(451, "4.3.0 queue unavailable, try again")
}

fn sender_refused() -> Reply {
    Reply::new(550, "5.7.1 sender domain not authorised for this pool")
}

impl Submission {
    async fn domain_allowed(&self, address: &str, pool: &str) -> Result<bool, Reply> {
        let Some(domain) = domain_of(address) else {
            return Ok(false);
        };
        match self.signers.for_domain(&domain, pool).await {
            Ok(signer) => Ok(signer.is_some()),
            Err(error) => {
                tracing::error!(%error, "checking the sender domain failed");
                Err(unavailable())
            }
        }
    }
}

/// Removes `Bcc`, adds `Date` and `Message-ID` when missing.
pub fn fix_headers(message_bytes: &[u8], hostname: &str) -> Vec<u8> {
    let (block, body) = message::split(message_bytes);
    let fields = message::headers(block);
    let mut out = Vec::with_capacity(message_bytes.len() + 128);
    if !fields.iter().any(|f| f.name.eq_ignore_ascii_case("date")) {
        let now = time::OffsetDateTime::now_utc();
        let date = now
            .format(&time::format_description::well_known::Rfc2822)
            .unwrap_or_default();
        out.extend_from_slice(format!("Date: {date}\r\n").as_bytes());
    }
    if !fields
        .iter()
        .any(|f| f.name.eq_ignore_ascii_case("message-id"))
    {
        out.extend_from_slice(format!("Message-ID: <{}@{hostname}>\r\n", new_id("")).as_bytes());
    }
    for field in &fields {
        if !field.name.eq_ignore_ascii_case("bcc") {
            out.extend_from_slice(&field.raw);
        }
    }
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body);
    out
}

impl Policy for Submission {
    fn hostname(&self) -> &str {
        &self.hostname
    }

    fn max_message_bytes(&self) -> usize {
        self.max_message_bytes
    }

    fn tls(&self) -> Option<TlsAcceptor> {
        self.tls.as_ref().map(|tls| tls.acceptor())
    }

    fn auth_required(&self) -> bool {
        true
    }

    fn authenticate(&self, user: &str, password: &str) -> Option<String> {
        let pool = user.to_ascii_lowercase();
        let expected = self.passwords.get(&pool)?;
        constant_time_eq(expected.as_bytes(), password.as_bytes()).then_some(pool)
    }

    fn mail<'a>(&'a self, session: &'a SessionInfo, from: &'a str) -> BoxFuture<'a, Reply> {
        Box::pin(async move {
            let Some(pool) = session.pool.as_deref() else {
                return Reply::new(530, "5.7.0 authentication required");
            };
            if from.is_empty() {
                return sender_refused();
            }
            match self.domain_allowed(from, pool).await {
                Ok(true) => Reply::new(250, "2.1.0 sender ok"),
                Ok(false) => sender_refused(),
                Err(reply) => reply,
            }
        })
    }

    fn rcpt<'a>(
        &'a self,
        session: &'a SessionInfo,
        _from: &'a str,
        to: &'a str,
    ) -> BoxFuture<'a, Reply> {
        Box::pin(async move {
            let pool = session.pool.as_deref().unwrap_or_default();
            match self.store.is_suppressed(pool, to).await {
                Ok(true) => Reply::new(
                    550,
                    "5.1.1 recipient suppressed after a bounce or complaint",
                ),
                Ok(false) => Reply::new(250, "2.1.5 recipient ok"),
                Err(error) => {
                    tracing::error!(%error, "suppression check failed");
                    unavailable()
                }
            }
        })
    }

    fn data<'a>(
        &'a self,
        session: &'a SessionInfo,
        transaction: Transaction,
    ) -> BoxFuture<'a, Reply> {
        Box::pin(async move {
            let pool = session.pool.clone().unwrap_or_default();
            let (block, _) = message::split(&transaction.message);
            let header_from = message::header_value(block, "from")
                .as_deref()
                .and_then(first_address)
                .unwrap_or_else(|| transaction.mail_from.to_lowercase());
            match self.domain_allowed(&header_from, &pool).await {
                Ok(true) => {}
                Ok(false) => return sender_refused(),
                Err(reply) => return reply,
            }
            let body = fix_headers(&transaction.message, &self.hostname);
            match self
                .store
                .enqueue(
                    &pool,
                    &transaction.mail_from,
                    &header_from,
                    &body,
                    &transaction.recipients,
                )
                .await
            {
                Ok(id) => {
                    tracing::info!(pool, message = %id, recipients = transaction.recipients.len(), "queued");
                    Reply::new(250, format!("2.0.0 queued as {id}"))
                }
                Err(error) => {
                    tracing::error!(%error, "enqueue failed");
                    unavailable()
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixes_headers() {
        let fixed = fix_headers(
            b"From: a@acme.eu\r\nBcc: secret@x.eu\r\nSubject: s\r\n\r\nbody\r\n",
            "mta.test",
        );
        let text = String::from_utf8(fixed).expect("utf8");
        assert!(text.starts_with("Date: "));
        assert!(text.contains("\r\nMessage-ID: <"));
        assert!(text.contains("@mta.test>\r\n"));
        assert!(!text.contains("Bcc"));
        assert!(text.ends_with("Subject: s\r\n\r\nbody\r\n"));

        let kept = fix_headers(b"Date: x\r\nMessage-ID: <1@a>\r\n\r\nb", "mta.test");
        assert_eq!(kept, b"Date: x\r\nMessage-ID: <1@a>\r\n\r\nb");
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
