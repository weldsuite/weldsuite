//! Consuming the event bus: what a subscriber is handed and what it answers.
//! Replaces the Cloudflare Queues consumer API (`MessageBatch`, `ack()`,
//! `retry()`) that the hub subscribers implement in TypeScript
//! (`apps/workers/audit-log-worker`, `integration-webhook-worker`,
//! `realtime-worker`, app-api's `search-index` consumer).
//!
//! The adapter (`weldsuite_adapters_oss::run_consumer` on NATS `JetStream`)
//! owns delivery: it fetches a batch, calls [`BatchHandler::handle`], then
//! acks, retries with backoff or dead-letters each message by its
//! [`Disposition`]. A handler only decides.

use std::time::Duration;

use crate::BoxFuture;

/// One message handed to a subscriber.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    /// The subject it was published on, `entity-events.customer.created`.
    pub subject: String,
    /// The serialised message (an `EntityEventMessage` for the hub).
    pub payload: Vec<u8>,
    /// Which delivery this is, from 1 (`message.attempts` on a queue).
    pub attempt: u64,
    /// How many [`Disposition::Defer`] waits it has had (as far as this
    /// process knows): the audit log's `auditLockRetries`.
    pub deferrals: u32,
}

/// What to do with one delivery after the handler ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposition {
    /// Done (`message.ack()`), including messages the subscriber chose to
    /// skip.
    Ack,
    /// Failed; try again later (`message.retry()`). Counts against the
    /// subscriber's retry budget; past it the message is dead-lettered.
    Retry { reason: String },
    /// Not ready yet; try again after `delay` without spending the retry
    /// budget. The audit log's wait for a tenant database locked by a move
    /// (`requeueLocked`, which re-sends the event with a delay and a fresh
    /// attempt count). The adapter bounds how many of these one message gets.
    Defer { delay: Duration, reason: String },
}

impl Disposition {
    pub fn retry(reason: impl Into<String>) -> Self {
        Self::Retry {
            reason: reason.into(),
        }
    }
}

/// A subscriber's batch handler: one [`Disposition`] per delivery, in order.
/// A handler that returns fewer leaves the rest to be retried.
pub trait BatchHandler: Send + Sync {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>>;
}
