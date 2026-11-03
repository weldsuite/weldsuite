//! `dispatch.ts` (cron, every minute) and the two queue consumers
//! (`send.ts`'s and `engage.ts`'s `handle*Batch`, `lib/queue.ts`).
//!
//! - scheduled messages whose time has come go to `reach-warmup-send`
//! - sent messages whose engagement time has come go to `reach-warmup-engage`
//!
//! Rows are claimed with a conditional UPDATE (`claimed_at` = now where it
//! is unset or older than [`CLAIM_TTL_MS`]), so overlapping runs never hand
//! out a row twice and a lost queue message is picked up again after the
//! claim expires. Messages that are hours overdue (an outage, the kill
//! switch) are failed instead of sent late.
//!
//! The queues are NATS `JetStream` (stream [`WARMUP_STREAM`], subjects
//! [`SEND_SUBJECT`] and [`ENGAGE_SUBJECT`], consumed by the
//! `reach-warmup-send` and `reach-warmup-engage` subscribers of
//! `weldsuite consume`). Without NATS the cron works the claimed messages
//! itself ([`WarmupQueue::Inline`]); a message that fails unexpectedly then
//! keeps its claim and is handed out again when the claim expires.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use weldsuite_ports::{BatchHandler, BoxFuture, BusMessage, Delivery, Disposition, DynEventBus};

use super::WarmupNetwork;
use super::clock::{HOUR_MS, Rng, random_float};
use super::db::{CLAIM_TTL_MS, is_warmup_enabled, release_claims, ts};
use super::engage::{EngageOutcome, process_engage};
use super::send::{SendOutcome, process_send};

/// Rows claimed per kind per tick.
pub const CLAIM_LIMIT: i64 = 200;
/// Messages published per batch (`sendBatch` takes at most 100).
pub const QUEUE_BATCH_SIZE: usize = 100;
/// A scheduled message this far past its time is dropped, not sent.
pub const STALE_SEND_AFTER_MS: i64 = 6 * HOUR_MS;
/// An engagement is attempted at most this many times.
pub const MAX_ENGAGE_ATTEMPTS: i32 = 3;

/// The `JetStream` stream and subjects of the two queues.
pub const WARMUP_STREAM: &str = "REACH_WARMUP";
pub const SEND_SUBJECT: &str = "reach.warmup.send";
pub const ENGAGE_SUBJECT: &str = "reach.warmup.engage";
/// The durable consumers' names (the subscribers of `weldsuite consume`).
pub const SEND_CONSUMER: &str = "reach-warmup-send";
pub const ENGAGE_CONSUMER: &str = "reach-warmup-engage";

/// A queue message (`WarmupSendMessage` / `WarmupEngageMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmupQueueMessage {
    /// Master `reach_warmup_messages.id`.
    pub message_id: String,
}

/// `parseMessageId(raw)`: the id of a queue body, or `None` when it is not
/// one (a poison message).
pub fn parse_message_id(payload: &[u8]) -> Option<String> {
    let message: WarmupQueueMessage = serde_json::from_slice(payload).ok()?;
    let length = message.message_id.chars().count();
    (1..=64).contains(&length).then_some(message.message_id)
}

/// Where claimed messages go.
pub enum WarmupQueue<'a> {
    /// Published on NATS for the consume subscribers.
    Nats(&'a dyn DynEventBus),
    /// Worked in this process, one after the other.
    Inline,
}

/// `DispatchResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DispatchResult {
    pub disabled: bool,
    pub expired: u64,
    pub send_queued: usize,
    pub engage_queued: usize,
}

/// `expireStale(master, now)`: failed rather than sent hours late.
async fn expire_stale(master: &PgPool, now: i64) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "update reach_warmup_messages set status = 'failed', error = 'expired', claimed_at = null
         where status = 'scheduled' and scheduled_at < $1::timestamptz",
    )
    .bind(ts(now - STALE_SEND_AFTER_MS))
    .execute(master)
    .await?
    .rows_affected())
}

/// The rows each UPDATE won, in the order they were read.
fn won_in_order(candidates: Vec<String>, won: &[String]) -> Vec<String> {
    candidates
        .into_iter()
        .filter(|id| won.contains(id))
        .collect()
}

/// `claimDueSends(master, now, limit)`, by `claimRows`: up to `limit` due
/// rows, oldest first. The ids are read first and the UPDATE repeats the
/// conditions, so of two overlapping runs only the one whose UPDATE reaches
/// a row first changes it.
pub async fn claim_due_sends(master: &PgPool, now: i64, limit: i64) -> sqlx::Result<Vec<String>> {
    let candidates: Vec<String> = sqlx::query_scalar(
        "select id from reach_warmup_messages
         where status = 'scheduled' and scheduled_at <= $1::timestamptz
           and (claimed_at is null or claimed_at < $2::timestamptz)
         order by scheduled_at asc limit $3",
    )
    .bind(ts(now))
    .bind(ts(now - CLAIM_TTL_MS))
    .bind(limit)
    .fetch_all(master)
    .await?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let won: Vec<String> = sqlx::query_scalar(
        "update reach_warmup_messages set claimed_at = $1::timestamptz
         where id = any($3) and status = 'scheduled' and scheduled_at <= $1::timestamptz
           and (claimed_at is null or claimed_at < $2::timestamptz)
         returning id",
    )
    .bind(ts(now))
    .bind(ts(now - CLAIM_TTL_MS))
    .bind(&candidates)
    .fetch_all(master)
    .await?;
    Ok(won_in_order(candidates, &won))
}

/// `claimDueEngagements(master, now, limit)`, the same way.
pub async fn claim_due_engagements(
    master: &PgPool,
    now: i64,
    limit: i64,
) -> sqlx::Result<Vec<String>> {
    let candidates: Vec<String> = sqlx::query_scalar(
        "select id from reach_warmup_messages
         where status = 'sent' and engage_at <= $1::timestamptz and engage_attempts < $4
           and (claimed_at is null or claimed_at < $2::timestamptz)
         order by engage_at asc limit $3",
    )
    .bind(ts(now))
    .bind(ts(now - CLAIM_TTL_MS))
    .bind(limit)
    .bind(MAX_ENGAGE_ATTEMPTS)
    .fetch_all(master)
    .await?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let won: Vec<String> = sqlx::query_scalar(
        "update reach_warmup_messages set claimed_at = $1::timestamptz
         where id = any($3) and status = 'sent' and engage_at <= $1::timestamptz and engage_attempts < $4
           and (claimed_at is null or claimed_at < $2::timestamptz)
         returning id",
    )
    .bind(ts(now))
    .bind(ts(now - CLAIM_TTL_MS))
    .bind(&candidates)
    .bind(MAX_ENGAGE_ATTEMPTS)
    .fetch_all(master)
    .await?;
    Ok(won_in_order(candidates, &won))
}

/// Publish claimed ids; a refused chunk gives its claims back.
async fn publish(
    master: &PgPool,
    bus: &dyn DynEventBus,
    subject: &str,
    ids: &[String],
    now: i64,
) -> usize {
    let mut queued = 0;
    for chunk in ids.chunks(QUEUE_BATCH_SIZE) {
        let mut published = 0;
        for id in chunk {
            let payload = serde_json::to_vec(&WarmupQueueMessage {
                message_id: id.clone(),
            })
            .unwrap_or_default();
            let message = BusMessage {
                subject: subject.to_owned(),
                id: format!("{subject}:{id}:{now}"),
                payload,
            };
            if let Err(error) = bus.publish_boxed(message).await {
                tracing::error!(%error, subject, "[reach-warmup] dispatch: the queue refused a message");
                break;
            }
            published += 1;
        }
        queued += published;
        if published < chunk.len() {
            let _ = release_claims(master, &chunk[published..]).await;
        }
    }
    queued
}

/// `runDispatchTick(env, deps)`. `clock` is read per worked message on the
/// inline queue (each runs at its own time, as a queue batch would).
pub async fn run_dispatch(
    net: &WarmupNetwork,
    queue: &WarmupQueue<'_>,
    clock: &(dyn Fn() -> i64 + Send + Sync),
    rng: Rng<'_>,
) -> Result<DispatchResult, String> {
    let now = clock();
    if !is_warmup_enabled(&net.flags).await {
        return Ok(DispatchResult {
            disabled: true,
            ..DispatchResult::default()
        });
    }
    let master = &net.master;
    let expired = expire_stale(master, now).await.map_err(|e| e.to_string())?;
    let sends = claim_due_sends(master, now, CLAIM_LIMIT)
        .await
        .map_err(|e| e.to_string())?;
    let (send_queued, engage_queued) = match queue {
        WarmupQueue::Nats(bus) => {
            let send_queued = publish(master, *bus, SEND_SUBJECT, &sends, now).await;
            let engagements = claim_due_engagements(master, now, CLAIM_LIMIT)
                .await
                .map_err(|e| e.to_string())?;
            let engage_queued = publish(master, *bus, ENGAGE_SUBJECT, &engagements, now).await;
            (send_queued, engage_queued)
        }
        WarmupQueue::Inline => {
            for id in &sends {
                log_send(id, process_send(net, id, clock(), &mut *rng).await);
            }
            let engagements = claim_due_engagements(master, clock(), CLAIM_LIMIT)
                .await
                .map_err(|e| e.to_string())?;
            for id in &engagements {
                log_engage(id, process_engage(net, id, clock(), &mut *rng).await);
            }
            (sends.len(), engagements.len())
        }
    };
    if expired > 0 || send_queued + engage_queued > 0 {
        tracing::info!(
            send = send_queued,
            engage = engage_queued,
            expired,
            "[reach-warmup] dispatch"
        );
    }
    Ok(DispatchResult {
        disabled: false,
        expired,
        send_queued,
        engage_queued,
    })
}

fn log_send(id: &str, outcome: Result<SendOutcome, String>) -> Disposition {
    match outcome {
        Ok(SendOutcome::Failed(error) | SendOutcome::Paused(error)) => {
            tracing::warn!(id, error, "[reach-warmup] send");
            Disposition::Ack
        }
        Ok(_) => Disposition::Ack,
        Err(error) => {
            tracing::error!(id, error, "[reach-warmup] send failed, will retry");
            Disposition::retry(error)
        }
    }
}

fn log_engage(id: &str, outcome: Result<EngageOutcome, String>) -> Disposition {
    match outcome {
        Ok(EngageOutcome::Failed(error)) => {
            tracing::warn!(id, error, "[reach-warmup] engage");
            Disposition::Ack
        }
        Ok(_) => Disposition::Ack,
        Err(error) => {
            tracing::error!(id, error, "[reach-warmup] engage failed, will retry");
            Disposition::retry(error)
        }
    }
}

/// Which queue a subscriber consumes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarmupQueueKind {
    Send,
    Engage,
}

/// `handleSendBatch` / `handleEngageBatch`: with the kill switch off, the
/// claims are handed back and the messages left for the dispatcher;
/// otherwise each message is worked, a poison body dropped.
pub async fn handle_batch(
    net: &WarmupNetwork,
    kind: WarmupQueueKind,
    payloads: &[&[u8]],
    now: i64,
    rng: Rng<'_>,
) -> Vec<Disposition> {
    let ids: Vec<Option<String>> = payloads.iter().map(|p| parse_message_id(p)).collect();
    if !is_warmup_enabled(&net.flags).await {
        let valid: Vec<String> = ids.iter().flatten().cloned().collect();
        if let Err(error) = release_claims(&net.master, &valid).await {
            tracing::warn!(%error, "[reach-warmup] could not hand claims back");
        }
        return vec![Disposition::Ack; payloads.len()];
    }
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(id) = id else {
            tracing::warn!("[reach-warmup] dropped a queue message without a messageId");
            out.push(Disposition::Ack);
            continue;
        };
        out.push(match kind {
            WarmupQueueKind::Send => log_send(&id, process_send(net, &id, now, &mut *rng).await),
            WarmupQueueKind::Engage => {
                log_engage(&id, process_engage(net, &id, now, &mut *rng).await)
            }
        });
    }
    out
}

/// The `reach-warmup-send` or `reach-warmup-engage` subscriber of
/// `weldsuite consume`.
pub struct WarmupSubscriber {
    network: WarmupNetwork,
    kind: WarmupQueueKind,
}

impl WarmupSubscriber {
    pub fn new(network: WarmupNetwork, kind: WarmupQueueKind) -> Self {
        Self { network, kind }
    }
}

impl BatchHandler for WarmupSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let payloads: Vec<&[u8]> = batch.iter().map(|d| d.payload.as_slice()).collect();
            let now = weldsuite_reach_domain::epoch_ms(weldsuite_reach_domain::now());
            let mut rng = random_float;
            handle_batch(&self.network, self.kind, &payloads, now, &mut rng).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_bodies_are_checked() {
        assert_eq!(
            parse_message_id(br#"{"messageId":"rwms_1"}"#).as_deref(),
            Some("rwms_1")
        );
        assert_eq!(parse_message_id(br#"{"messageId":""}"#), None);
        assert_eq!(parse_message_id(b"not json"), None);
        let long = format!(r#"{{"messageId":"{}"}}"#, "x".repeat(65));
        assert_eq!(parse_message_id(long.as_bytes()), None);
    }
}
