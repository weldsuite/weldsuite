//! A workspace's mailbox contents (`@weldsuite/mail-domain/store`).
//!
//! On Kubernetes mailbox contents live in the tenant Postgres tables
//! (`mail_messages`, `mail_attachments`, …): the `weldmail-mailbox-store`
//! flag is fixed at `postgres` there (MAIL-010). So [`MailboxStore`] has one
//! implementation, [`PostgresMailboxStore`] (`store/postgres`); the Durable
//! Object modes (`shadow`, `object`, `object-only`) stay TypeScript-only.
//!
//! As in TypeScript, a workspace's store hands out one mailbox at a time
//! ([`PostgresMailStore::mailbox`], `store.mailbox(accountId)`), and the
//! caller checks access ([`crate::access`]) before it reads one. Add a read
//! to the trait when a ported route needs it, with the TypeScript method it
//! mirrors.

use std::collections::HashSet;
use std::future::Future;

use serde_json::Value;
use weldsuite_db::PgPool;

/// How many of a mailbox's newest messages `recentAddresses` reads
/// (`PostgresMailboxStore.recentAddresses`).
pub const RECENT_ADDRESS_SAMPLE: i64 = 200;

/// One mailbox's contents (`MailboxStore`, bound to its account).
pub trait MailboxStore: Send + Sync {
    /// `recentAddresses(limit)`: the distinct `from` and `to` addresses of
    /// the mailbox's 200 newest live messages, trimmed and lowercased, in
    /// the order met (newest message first, its sender before its
    /// recipients), at most `limit`.
    fn recent_addresses(
        &self,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<String>, sqlx::Error>> + Send;
}

/// A workspace's mail store over its tenant database (`postgres` mode).
#[derive(Debug, Clone)]
pub struct PostgresMailStore {
    pub db: PgPool,
}

impl PostgresMailStore {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }

    /// `store.mailbox(accountId)`.
    pub fn mailbox(&self, account_id: &str) -> PostgresMailboxStore {
        PostgresMailboxStore {
            db: self.db.clone(),
            account_id: account_id.to_owned(),
        }
    }
}

/// One mailbox in the tenant database (`store/postgres/mailbox-store.ts`).
#[derive(Debug, Clone)]
pub struct PostgresMailboxStore {
    db: PgPool,
    account_id: String,
}

impl PostgresMailboxStore {
    /// The mailbox's `mail_accounts.id`.
    pub fn account_id(&self) -> &str {
        &self.account_id
    }
}

impl MailboxStore for PostgresMailboxStore {
    async fn recent_addresses(&self, limit: usize) -> Result<Vec<String>, sqlx::Error> {
        let rows: Vec<(Option<String>, Option<Value>)> = sqlx::query_as(
            "select \"from\"->>'email', \"to\" from mail_messages
             where account_id = $1 and deleted_at is null
             order by sent_date desc
             limit $2",
        )
        .bind(&self.account_id)
        .bind(RECENT_ADDRESS_SAMPLE)
        .fetch_all(&self.db)
        .await?;
        let mut seen = HashSet::new();
        let mut addresses = Vec::new();
        let mut add = |email: &str| {
            let email = email.trim().to_lowercase();
            if seen.insert(email.clone()) {
                addresses.push(email);
            }
        };
        for (from, to) in rows {
            if let Some(from) = from.filter(|from| !from.is_empty()) {
                add(&from);
            }
            if let Some(Value::Array(recipients)) = to {
                for recipient in recipients {
                    if let Some(email) = recipient
                        .get("email")
                        .and_then(Value::as_str)
                        .filter(|email| !email.is_empty())
                    {
                        add(email);
                    }
                }
            }
        }
        addresses.truncate(limit);
        Ok(addresses)
    }
}
