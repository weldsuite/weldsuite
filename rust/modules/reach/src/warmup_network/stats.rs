//! `stats.ts` (daily): per pool mailbox, what the network measured over the
//! last 3 and 7 days, written to `reach_warmup_mailboxes.stats` for the
//! health gate and the Mailboxes screen.
//!
//! Placement is judged at the recipient: a mailbox's `inbox3d` counts ITS
//! OWN sent mail that landed in the inbox of whoever received it. Two
//! aggregate queries and one UPDATE per 100 mailboxes.

use std::collections::HashMap;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_reach_domain::warmup::inbox_rate;

use super::clock::DAY_MS;
use super::db::ts;

/// Mailboxes written per UPDATE statement.
const WRITE_CHUNK: usize = 100;

/// `RolledUpMailbox`.
#[derive(Debug, Clone, PartialEq)]
pub struct RolledUpMailbox {
    pub id: String,
    pub status: String,
    /// The `ReachWarmupStats` object.
    pub stats: Value,
    pub inbox_rate_3d: Option<f64>,
}

/// One mailbox's sent-side counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, sqlx::FromRow)]
pub struct SentCounts {
    pub sent7d: i64,
    pub inbox3d: i64,
    pub spam3d: i64,
    pub missing3d: i64,
    pub inbox7d: i64,
    pub spam7d: i64,
    pub missing7d: i64,
}

/// One mailbox's received-side counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReceivedCounts {
    pub received7d: i64,
    pub spam_rescues7d: i64,
}

type SentRow = (String, i64, i64, i64, i64, i64, i64, i64);

async fn read_sent(master: &PgPool, now: i64) -> sqlx::Result<HashMap<String, SentCounts>> {
    let sql = "select from_mailbox_id, count(*)::int8,
           (count(*) filter (where placement = 'inbox' and sent_at >= $1::timestamptz))::int8,
           (count(*) filter (where placement = 'spam' and sent_at >= $1::timestamptz))::int8,
           (count(*) filter (where placement = 'missing' and sent_at >= $1::timestamptz))::int8,
           (count(*) filter (where placement = 'inbox' and sent_at >= $2::timestamptz))::int8,
           (count(*) filter (where placement = 'spam' and sent_at >= $2::timestamptz))::int8,
           (count(*) filter (where placement = 'missing' and sent_at >= $2::timestamptz))::int8
         from reach_warmup_messages where sent_at >= $2::timestamptz group by from_mailbox_id";
    let rows: Vec<SentRow> = sqlx::query_as(sql)
        .bind(ts(now - 3 * DAY_MS))
        .bind(ts(now - 7 * DAY_MS))
        .fetch_all(master)
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, sent7d, inbox3d, spam3d, missing3d, inbox7d, spam7d, missing7d)| {
                (
                    id,
                    SentCounts {
                        sent7d,
                        inbox3d,
                        spam3d,
                        missing3d,
                        inbox7d,
                        spam7d,
                        missing7d,
                    },
                )
            },
        )
        .collect())
}

async fn read_received(master: &PgPool, now: i64) -> sqlx::Result<HashMap<String, ReceivedCounts>> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "select to_mailbox_id, count(*)::int8,
           (count(*) filter (where actions->>'movedFromSpam' = 'true'))::int8
         from reach_warmup_messages where sent_at >= $1::timestamptz group by to_mailbox_id",
    )
    .bind(ts(now - 7 * DAY_MS))
    .fetch_all(master)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, received7d, spam_rescues7d)| {
            (
                id,
                ReceivedCounts {
                    received7d,
                    spam_rescues7d,
                },
            )
        })
        .collect())
}

/// A rate as JavaScript writes it: integral values as integers (jsonb keeps
/// the scale of `0.0`).
fn rate_json(rate: Option<f64>) -> Value {
    match rate {
        Some(r) if r.fract() == 0.0 => json!(r as i64),
        Some(r) => json!(r),
        None => Value::Null,
    }
}

/// `buildStats(sent, received, now)`.
pub fn build_stats(
    sent: Option<&SentCounts>,
    received: Option<&ReceivedCounts>,
    now: i64,
) -> Value {
    let s = sent.copied().unwrap_or_default();
    let r = received.copied().unwrap_or_default();
    json!({
        "sent7d": s.sent7d,
        "received7d": r.received7d,
        "inbox3d": s.inbox3d,
        "spam3d": s.spam3d,
        "missing3d": s.missing3d,
        "inbox7d": s.inbox7d,
        "spam7d": s.spam7d,
        "missing7d": s.missing7d,
        "inboxRate3d": rate_json(inbox_rate(s.inbox3d, s.spam3d, s.missing3d)),
        "inboxRate7d": rate_json(inbox_rate(s.inbox7d, s.spam7d, s.missing7d)),
        "spamRescues7d": r.spam_rescues7d,
        "rolledUpAt": ts(now),
    })
}

async fn write_stats(master: &PgPool, rolled: &[RolledUpMailbox]) -> sqlx::Result<()> {
    for chunk in rolled.chunks(WRITE_CHUNK) {
        let ids: Vec<&str> = chunk.iter().map(|m| m.id.as_str()).collect();
        let stats: Vec<String> = chunk.iter().map(|m| m.stats.to_string()).collect();
        sqlx::query(
            "update reach_warmup_mailboxes as m set stats = v.stats::jsonb
             from unnest($1::text[], $2::text[]) as v(id, stats) where m.id = v.id",
        )
        .bind(&ids)
        .bind(&stats)
        .execute(master)
        .await?;
    }
    Ok(())
}

/// `rollUpStats(master, now)`: recompute and store the stats of every pool
/// mailbox that is not removed.
pub async fn roll_up_stats(master: &PgPool, now: i64) -> sqlx::Result<Vec<RolledUpMailbox>> {
    let mailboxes: Vec<(String, String)> =
        sqlx::query_as("select id, status from reach_warmup_mailboxes where status <> 'removed'")
            .fetch_all(master)
            .await?;
    let sent = read_sent(master, now).await?;
    let received = read_received(master, now).await?;
    let rolled: Vec<RolledUpMailbox> = mailboxes
        .into_iter()
        .map(|(id, status)| {
            let mine = sent.get(&id);
            let rate = mine.and_then(|s| inbox_rate(s.inbox3d, s.spam3d, s.missing3d));
            RolledUpMailbox {
                stats: build_stats(mine, received.get(&id), now),
                inbox_rate_3d: rate,
                id,
                status,
            }
        })
        .collect();
    write_stats(master, &rolled).await?;
    Ok(rolled)
}
