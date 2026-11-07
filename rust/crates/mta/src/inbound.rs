//! The bounce MX: port 25 on the mail nodes, the MX of `MTA_BOUNCE_DOMAIN`.
//! It takes only the return path's addresses ([`crate::verp`]): a VERP
//! address with a valid tag, `fbl@` for feedback loops, `postmaster@` and
//! `abuse@`. Everything else is refused at `RCPT TO`, so it is no open
//! relay and no inbox.
//!
//! A DSN to a VERP address bounces that recipient (the id in the address
//! wins over the report's `Final-Recipient`, which a forwarder may have
//! rewritten). A complaint to `fbl@` (or to a VERP address) is matched by
//! the original's `X-WeldSuite-Mta-Id` or its VERP `Original-Mail-From`.
//! `250` once handled; `451` when the database is down, so the sender
//! retries.

use tokio_rustls::TlsAcceptor;

use crate::BoxFuture;
use crate::crypto::Keys;
use crate::feedback::{self, Report};
use crate::smtp::Reply;
use crate::smtp::server::{Policy, SessionInfo, Transaction};
use crate::store::{Store, StoreError};
use crate::verp::{self, ReturnAddress};

/// Reports are small; a DSN quoting a whole message is cut off by its
/// sender long before this.
pub const MAX_REPORT_BYTES: usize = 10 * 1024 * 1024;

pub struct BounceMx {
    pub hostname: String,
    pub bounce_domain: String,
    pub keys: Keys,
    pub store: Store,
    pub tls: Option<std::sync::Arc<crate::tls::Reloading>>,
}

impl BounceMx {
    /// Applies a report sent to `to`. Returns what was recorded, for logs.
    pub async fn handle(&self, to: &str, message: &[u8]) -> Result<&'static str, StoreError> {
        let Some(kind) = verp::parse(&self.keys, to, &self.bounce_domain) else {
            return Ok("not ours");
        };
        let report = feedback::parse(message);
        match (kind, report) {
            (ReturnAddress::Recipient(id), Report::Dsn(recipients)) => {
                let Some(failed) = recipients.iter().find(|r| r.action == "failed") else {
                    return Ok("dsn without a failure");
                };
                let Some(info) = self.store.recipient(&id).await? else {
                    return Ok("unknown recipient");
                };
                let status = feedback::parse_status(&failed.status);
                let text = failed
                    .diagnostic
                    .clone()
                    .unwrap_or_else(|| failed.status.clone());
                let code = text.get(..3).and_then(|c| c.parse().ok()).unwrap_or(550);
                let hard = matches!(status, Some((5, _, _)))
                    && feedback::hard_failure(status, code, &text);
                let detail = format!("{} (late bounce) {text}", failed.status);
                Ok(if self.store.late_bounce(&info, hard, &detail).await? {
                    "late bounce recorded"
                } else {
                    "already final"
                })
            }
            (
                ReturnAddress::Recipient(_) | ReturnAddress::FeedbackLoop,
                Report::Complaint {
                    feedback_type,
                    mta_id,
                    original_mail_from,
                },
            ) => {
                let id = mta_id.or_else(|| {
                    original_mail_from.and_then(|from| {
                        match verp::parse(&self.keys, &from, &self.bounce_domain) {
                            Some(ReturnAddress::Recipient(id)) => Some(id),
                            _ => None,
                        }
                    })
                });
                let Some(id) = id else {
                    return Ok("complaint without a match");
                };
                let Some(info) = self.store.recipient(&id).await? else {
                    return Ok("unknown recipient");
                };
                Ok(if self.store.complaint(&info, &feedback_type).await? {
                    "complaint recorded"
                } else {
                    "complaint already recorded"
                })
            }
            (ReturnAddress::Role, _) => Ok("role address"),
            _ => Ok("ignored"),
        }
    }
}

impl Policy for BounceMx {
    fn hostname(&self) -> &str {
        &self.hostname
    }

    fn max_message_bytes(&self) -> usize {
        MAX_REPORT_BYTES
    }

    fn tls(&self) -> Option<TlsAcceptor> {
        self.tls.as_ref().map(|tls| tls.acceptor())
    }

    fn auth_required(&self) -> bool {
        false
    }

    fn authenticate(&self, _user: &str, _password: &str) -> Option<String> {
        None
    }

    fn mail<'a>(&'a self, _session: &'a SessionInfo, _from: &'a str) -> BoxFuture<'a, Reply> {
        Box::pin(async { Reply::new(250, "2.1.0 ok") })
    }

    fn rcpt<'a>(
        &'a self,
        _session: &'a SessionInfo,
        _from: &'a str,
        to: &'a str,
    ) -> BoxFuture<'a, Reply> {
        Box::pin(async move {
            if verp::parse(&self.keys, to, &self.bounce_domain).is_some() {
                Reply::new(250, "2.1.5 ok")
            } else {
                Reply::new(550, "5.1.1 no such mailbox")
            }
        })
    }

    fn data<'a>(
        &'a self,
        session: &'a SessionInfo,
        transaction: Transaction,
    ) -> BoxFuture<'a, Reply> {
        Box::pin(async move {
            for to in &transaction.recipients {
                match self.handle(to, &transaction.message).await {
                    Ok(outcome) => {
                        tracing::info!(peer = %session.peer, recipient = %to, outcome, "return path");
                    }
                    Err(error) => {
                        tracing::error!(%error, "return path: database unavailable");
                        return Reply::new(451, "4.3.0 try again later");
                    }
                }
            }
            Reply::new(250, "2.0.0 thanks")
        })
    }
}
