//! `email/handler.ts`: replies, auto-replies and bounces of WeldReach
//! mailboxes, on the Kubernetes editions.
//!
//! Each Mailpool mailbox forwards its incoming mail to
//! `reply+<inboundToken>@<REACH_INBOUND_DOMAIN>`. On Global, Cloudflare Email
//! Routing delivers it to reach-api's `email()`; here Haraka is the MX of
//! that domain (MAIL-010): its RCPT check accepts the address while master
//! `reach_routes` holds an active `inbound_token` route for the token
//! ([`accepts_recipient`]), and `weldsuite consume`'s `mail-inbound`
//! subscriber hands the spooled message to [`ReachInbound::process`] before
//! WeldMail sees the other recipients.
//!
//! Warmup mail (the WeldSuite warmup network writing to the mailbox) is
//! recognised by its Message-ID, In-Reply-To or References in master
//! `reach_warmup_messages` and dropped without a trace. The handler never
//! bounces: an unknown token is dropped, and a failure while processing is
//! logged and the raw message parked in `STORAGE` for replay.

use std::sync::Arc;

use sqlx::PgPool;
use weldsuite_events::{EntityEventPublisher, EventContext, EventSource};
use weldsuite_ports::{BoxFuture, DynFileStore, PutOptions};

use super::deliver::{DeliverInput, DeliverResult, InboundMailbox, deliver_inbound};
use super::parse::{ParsedInbound, parse_inbound, parse_inbound_token, sha256_hex};
use crate::send::SystemEvents;

/// Messages above this size are dropped (`MAX_INBOUND_BYTES`).
pub const MAX_INBOUND_BYTES: usize = 10 * 1024 * 1024;

/// References beyond this many (newest first) are not looked up.
const MAX_REFERENCE_LOOKUPS: usize = 20;

/// `InboundRoute`: a token's workspace and mailbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundRoute {
    pub clerk_org_id: String,
    pub mailbox_id: String,
}

/// `resolveInboundRoute(env, token)`: an active `inbound_token` route.
pub async fn resolve_inbound_route(
    master: &PgPool,
    token: &str,
) -> Result<Option<InboundRoute>, sqlx::Error> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "select clerk_org_id, tenant_entity_id from reach_routes
         where kind = 'inbound_token' and external_id = $1 and status = 'active' limit 1",
    )
    .bind(token)
    .fetch_optional(master)
    .await?;
    Ok(row.map(|(clerk_org_id, mailbox_id)| InboundRoute {
        clerk_org_id,
        mailbox_id: mailbox_id.unwrap_or_default(),
    }))
}

/// The RCPT check for the reply domain: `reply+<token>@<inbound domain>`
/// with an active route. Any other address is not WeldReach's.
pub async fn accepts_recipient(
    master: &PgPool,
    inbound_domain: &str,
    address: &str,
) -> Result<bool, sqlx::Error> {
    let Some(token) = parse_inbound_token(address, Some(inbound_domain)) else {
        return Ok(false);
    };
    Ok(resolve_inbound_route(master, &token).await?.is_some())
}

/// `threadingIdsOf(parsed)`: its own id, what it answers, and the newest
/// references, without duplicates.
pub fn threading_ids_of(parsed: &ParsedInbound) -> Vec<String> {
    let skip = parsed
        .references
        .len()
        .saturating_sub(MAX_REFERENCE_LOOKUPS);
    let ids: Vec<String> = parsed
        .message_id
        .iter()
        .chain(parsed.in_reply_to.iter())
        .chain(parsed.references[skip..].iter())
        .filter(|id| !id.is_empty())
        .cloned()
        .collect();
    weldsuite_reach_domain::unique(&ids)
}

/// Opens a workspace's tenant database by its Clerk org id.
pub type InboundTenants =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// What the inbound path needs.
#[derive(Clone)]
pub struct ReachInbound {
    pub master: PgPool,
    pub tenants: InboundTenants,
    /// `STORAGE`: raw replies, and the messages that could not be processed.
    pub storage: Option<Arc<dyn DynFileStore>>,
    pub events: EntityEventPublisher,
    /// `REACH_INBOUND_DOMAIN`.
    pub inbound_domain: String,
}

impl std::fmt::Debug for ReachInbound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReachInbound")
            .field("inbound_domain", &self.inbound_domain)
            .field("storage", &self.storage.is_some())
            .finish_non_exhaustive()
    }
}

/// Why a message was not delivered (for logs and tests).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dropped {
    NotInbound,
    TooLarge,
    RouteLookupFailed,
    UnknownToken,
    Warmup,
    MailboxGone,
    Failed,
}

impl ReachInbound {
    /// Whether `recipient` is one of WeldReach's reply addresses (its
    /// domain and a well-formed token); the route is checked when the
    /// message is processed.
    pub fn claims(&self, recipient: &str) -> bool {
        parse_inbound_token(recipient, Some(&self.inbound_domain)).is_some()
    }

    async fn load_mailbox(
        db: &PgPool,
        mailbox_id: &str,
        token: &str,
    ) -> Result<Option<InboundMailbox>, sqlx::Error> {
        let row: Option<(String, String, Option<String>)> = sqlx::query_as(
            "select id, email, deleted_at::text from reach_mailboxes where id = $1 and inbound_token = $2 limit 1",
        )
        .bind(mailbox_id)
        .bind(token)
        .fetch_optional(db)
        .await?;
        Ok(row
            .filter(|(_, _, deleted)| deleted.is_none())
            .map(|(id, email, _)| InboundMailbox { id, email }))
    }

    /// `parkFailed(env, clerkOrgId, raw)`: best effort.
    async fn park_failed(&self, clerk_org_id: &str, raw: &[u8]) {
        let Some(storage) = &self.storage else {
            return;
        };
        let key = format!("reach/{clerk_org_id}/_failed/{}.eml", sha256_hex(raw));
        let options = PutOptions {
            content_type: Some("message/rfc822".to_owned()),
            ..PutOptions::default()
        };
        if let Err(error) = storage.put_boxed(&key, raw.to_vec(), &options).await {
            tracing::error!(%error, "[reach-inbound] could not park the failed message");
        }
    }

    /// `screenForWarmup(raw)`: best effort; a message that cannot be parsed
    /// or a master that cannot answer is "not warmup".
    async fn screen_for_warmup(&self, raw: &[u8]) -> (bool, Option<ParsedInbound>) {
        let parsed = match parse_inbound(raw) {
            Ok(parsed) => parsed,
            Err(error) => {
                tracing::error!(%error, "[reach-inbound] warmup screening could not parse the message");
                return (false, None);
            }
        };
        let ids = threading_ids_of(&parsed);
        if ids.is_empty() {
            return (false, Some(parsed));
        }
        match weldsuite_reach_domain::warmup_pool::find_warmup_message_ids(&self.master, &ids).await
        {
            Ok(found) => (!found.is_empty(), Some(parsed)),
            Err(error) => {
                tracing::error!(error = %error.message, "[reach-inbound] warmup lookup failed, processing the message normally");
                (false, Some(parsed))
            }
        }
    }

    /// `processInboundEmail(message)`: one forwarded message for one
    /// recipient. Never fails.
    pub async fn process(&self, recipient: &str, raw: &[u8]) -> Result<DeliverResult, Dropped> {
        let Some(token) = parse_inbound_token(recipient, Some(&self.inbound_domain)) else {
            tracing::warn!("[reach-inbound] dropped: recipient is not an inbound address");
            return Err(Dropped::NotInbound);
        };
        if raw.len() > MAX_INBOUND_BYTES {
            tracing::warn!(
                bytes = raw.len(),
                "[reach-inbound] dropped: over the size cap"
            );
            return Err(Dropped::TooLarge);
        }
        let route = match resolve_inbound_route(&self.master, &token).await {
            Ok(Some(route)) => route,
            Ok(None) => {
                tracing::warn!("[reach-inbound] dropped: unknown inbound token");
                return Err(Dropped::UnknownToken);
            }
            Err(error) => {
                tracing::error!(%error, "[reach-inbound] route lookup failed");
                return Err(Dropped::RouteLookupFailed);
            }
        };
        // Warmup mail is dropped before the tenant is opened.
        let (warmup, parsed) = self.screen_for_warmup(raw).await;
        if warmup {
            tracing::warn!("[reach-inbound] dropped: warmup network mail");
            return Err(Dropped::Warmup);
        }
        match self.deliver(&route, &token, raw, parsed).await {
            Ok(Some(result)) => {
                tracing::info!(result = %result.to_json(), "[reach-inbound] processed");
                Ok(result)
            }
            Ok(None) => {
                tracing::warn!(
                    "[reach-inbound] dropped: the mailbox of this route no longer exists"
                );
                Err(Dropped::MailboxGone)
            }
            Err(error) => {
                tracing::error!(%error, "[reach-inbound] processing failed");
                self.park_failed(&route.clerk_org_id, raw).await;
                Err(Dropped::Failed)
            }
        }
    }

    async fn deliver(
        &self,
        route: &InboundRoute,
        token: &str,
        raw: &[u8],
        parsed: Option<ParsedInbound>,
    ) -> Result<Option<DeliverResult>, String> {
        let db = (self.tenants)(route.clerk_org_id.clone()).await?;
        let Some(mailbox) = Self::load_mailbox(&db, &route.mailbox_id, token)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        let events = SystemEvents {
            publisher: &self.events,
            context: EventContext::new(route.clerk_org_id.clone(), "system", EventSource::System),
        };
        deliver_inbound(DeliverInput {
            db: &db,
            clerk_org_id: &route.clerk_org_id,
            mailbox: &mailbox,
            raw,
            parsed,
            storage: self.storage.clone(),
            events: &events,
            now: weldsuite_reach_domain::now(),
        })
        .await
        .map(Some)
        .map_err(|e| e.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(
        message_id: Option<&str>,
        in_reply_to: Option<&str>,
        references: &[String],
    ) -> ParsedInbound {
        ParsedInbound {
            message_id: message_id.map(str::to_owned),
            in_reply_to: in_reply_to.map(str::to_owned),
            references: references.to_vec(),
            ..ParsedInbound::default()
        }
    }

    #[test]
    fn threading_ids() {
        let refs = vec!["a@x".to_owned(), "b@x".to_owned()];
        assert_eq!(
            threading_ids_of(&parsed(Some("m@x"), Some("b@x"), &refs)),
            ["m@x", "b@x", "a@x"]
        );
        assert_eq!(threading_ids_of(&parsed(None, None, &[])).len(), 0);
        let long: Vec<String> = (0..30).map(|i| format!("r{i}@x")).collect();
        let ids = threading_ids_of(&parsed(None, None, &long));
        assert_eq!(ids.len(), 20);
        assert_eq!(ids[0], "r10@x");
    }
}
