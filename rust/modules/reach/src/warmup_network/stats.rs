//! `stats.ts` (daily): per pool mailbox, what the network measured over the
//! last 3 and 7 days, written to `reach_warmup_mailboxes.stats` for the
//! health gate and the Mailboxes screen.
//!
//! Placement is judged at the recipient: a mailbox's `inbox3d` counts ITS
//! OWN sent mail that landed in the inbox of whoever received it. Two
//! aggregate queries and one UPDATE per 100 mailboxes.

use std::collections::HashMap;

use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, QueryFilter, QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::orm;
use weldsuite_reach_domain::warmup::inbox_rate;
use weldsuite_schema::master::{reach_warmup_mailboxes as pool, reach_warmup_messages as messages};

use super::clock::DAY_MS;
use super::db::{at, ts};

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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
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

/// `count(*) filter (where …)`: the rows the case keeps (it is null otherwise).
fn count_where(condition: Condition) -> Expr {
    Expr::from(Func::count(Expr::case(condition, 1)))
}

/// One sender's counts as the query names them.
#[derive(Debug, FromQueryResult)]
struct SentRow {
    from_mailbox_id: String,
    sent7d: i64,
    inbox3d: i64,
    spam3d: i64,
    missing3d: i64,
    inbox7d: i64,
    spam7d: i64,
    missing7d: i64,
}

async fn read_sent(master: &PgPool, now: i64) -> Result<HashMap<String, SentCounts>, DbErr> {
    use messages::Column;
    let (three, seven) = (at(now - 3 * DAY_MS), at(now - 7 * DAY_MS));
    let placed = |placement: &str, since| {
        count_where(
            Condition::all()
                .add(Column::Placement.eq(placement))
                .add(Column::SentAt.gte(since)),
        )
    };
    let rows = messages::Entity::find()
        .select_only()
        .column(Column::FromMailboxId)
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "sent7d")
        .column_as(placed("inbox", three), "inbox3d")
        .column_as(placed("spam", three), "spam3d")
        .column_as(placed("missing", three), "missing3d")
        .column_as(placed("inbox", seven), "inbox7d")
        .column_as(placed("spam", seven), "spam7d")
        .column_as(placed("missing", seven), "missing7d")
        .filter(Column::SentAt.gte(seven))
        .group_by(Column::FromMailboxId)
        .into_model::<SentRow>()
        .all(&orm(master))
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.from_mailbox_id,
                SentCounts {
                    sent7d: row.sent7d,
                    inbox3d: row.inbox3d,
                    spam3d: row.spam3d,
                    missing3d: row.missing3d,
                    inbox7d: row.inbox7d,
                    spam7d: row.spam7d,
                    missing7d: row.missing7d,
                },
            )
        })
        .collect())
}

async fn read_received(
    master: &PgPool,
    now: i64,
) -> Result<HashMap<String, ReceivedCounts>, DbErr> {
    use messages::Column;
    // `actions->>'movedFromSpam' = 'true'`
    let rescued = sea_orm::ExprTrait::eq(
        pg::PgExpr::cast_json_field(Expr::col(Column::Actions), "movedFromSpam"),
        "true",
    );
    let rows: Vec<(String, i64, i64)> = messages::Entity::find()
        .select_only()
        .column(Column::ToMailboxId)
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "received7d")
        .column_as(count_where(Condition::all().add(rescued)), "spam_rescues7d")
        .filter(Column::SentAt.gte(at(now - 7 * DAY_MS)))
        .group_by(Column::ToMailboxId)
        .into_tuple()
        .all(&orm(master))
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

/// One UPDATE per [`WRITE_CHUNK`] mailboxes: `stats = case id when … then …
/// end where id in (…)`, each mailbox its own stats.
async fn write_stats(master: &PgPool, rolled: &[RolledUpMailbox]) -> Result<(), DbErr> {
    for chunk in rolled.chunks(WRITE_CHUNK) {
        let mut rows = chunk.iter();
        let Some(first) = rows.next() else {
            continue;
        };
        let mut stats = Expr::case(
            pool::Column::Id.eq(&first.id),
            Expr::value(first.stats.clone()),
        );
        for row in rows {
            stats = stats.case(pool::Column::Id.eq(&row.id), Expr::value(row.stats.clone()));
        }
        pool::Entity::update_many()
            .col_expr(pool::Column::Stats, Into::<Expr>::into(stats))
            .filter(pool::Column::Id.is_in(chunk.iter().map(|m| m.id.as_str())))
            .exec(&orm(master))
            .await?;
    }
    Ok(())
}

/// `rollUpStats(master, now)`: recompute and store the stats of every pool
/// mailbox that is not removed.
pub async fn roll_up_stats(master: &PgPool, now: i64) -> Result<Vec<RolledUpMailbox>, DbErr> {
    let mailboxes: Vec<(String, String)> = pool::Entity::find()
        .select_only()
        .columns([pool::Column::Id, pool::Column::Status])
        .filter(pool::Column::Status.ne("removed"))
        .into_tuple()
        .all(&orm(master))
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
