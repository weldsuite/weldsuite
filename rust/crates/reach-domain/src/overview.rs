//! `overview.ts`: the overview numbers, and the "sent today" counts the send
//! engine shares. "Today" starts at midnight in the workspace's default
//! time zone.

use std::collections::HashMap;

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;

use crate::send_window::{add_minutes, start_of_zoned_day, utc_ms, zoned_midnight, zoned_parts};
use crate::{ReachResult, from_epoch_ms, iso};

/// `DEFAULT_DAY_TIMEZONE`.
pub const DEFAULT_DAY_TIMEZONE: &str = "Europe/Amsterdam";
const SERIES_DAYS: i64 = 14;
const WINDOW_DAYS: usize = 7;

/// `SentToday`.
#[derive(Debug, Clone, Default)]
pub struct SentToday {
    pub by_mailbox: HashMap<String, i64>,
    pub by_campaign: HashMap<String, i64>,
    pub total: i64,
}

/// `countSentToday(db, dayStart)`.
pub async fn count_sent_today(db: &PgPool, day_start: OffsetDateTime) -> ReachResult<SentToday> {
    let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "select mailbox_id, campaign_id, count(*) from reach_messages
         where direction = 'out' and (sent_at >= $1::timestamptz
             or (sent_at is null and status in ('sending', 'unknown') and created_at >= $1::timestamptz))
         group by mailbox_id, campaign_id",
    )
    .bind(iso(day_start))
    .fetch_all(db)
    .await?;
    let mut out = SentToday::default();
    for (mailbox, campaign, n) in rows {
        out.total += n;
        *out.by_mailbox.entry(mailbox).or_default() += n;
        if let Some(campaign) = campaign {
            *out.by_campaign.entry(campaign).or_default() += n;
        }
    }
    Ok(out)
}

/// `ratio(num, den)`: capped at 1, four decimals.
fn ratio(num: i64, den: i64) -> f64 {
    if den <= 0 {
        return 0.0;
    }
    let raw = num as f64 / den as f64 * 10_000.0;
    (raw + 0.5).floor().min(10_000.0) / 10_000.0
}

fn local_date_key(at: OffsetDateTime, timezone: &str) -> String {
    let p = zoned_parts(at, timezone);
    format!("{}-{:02}-{:02}", p.year, p.month, p.day)
}

/// `buildOverview(db, now)`.
pub async fn build(db: &PgPool, now: OffsetDateTime) -> ReachResult<Value> {
    let settings = crate::campaigns::load_settings(db).await?;
    let tz = settings
        .as_ref()
        .and_then(|s| crate::text(s, "defaultTimezone"))
        .unwrap_or(DEFAULT_DAY_TIMEZONE)
        .to_owned();
    let today = start_of_zoned_day(now, &tz);
    let local = zoned_parts(now, &tz);
    let day_starts: Vec<OffsetDateTime> = (0..SERIES_DAYS)
        .rev()
        .map(|back| {
            let day = from_epoch_ms(utc_ms(local.year, local.month, local.day - back, 0, 0, 0));
            zoned_midnight(
                i64::from(day.year()),
                i64::from(u8::from(day.month())),
                i64::from(day.day()),
                &tz,
            )
        })
        .collect();
    let series_start = day_starts.first().copied().unwrap_or(today);
    let window_start = day_starts
        .get(usize::try_from(SERIES_DAYS).unwrap_or_default() - WINDOW_DAYS)
        .copied()
        .unwrap_or(today);
    let sent_rows: Vec<(Option<String>, i64)> = sqlx::query_as(
        "select to_char(timezone($1, sent_at), 'YYYY-MM-DD'), count(*)::int8 from reach_messages
         where direction = 'out' and status = 'sent' and sent_at >= $2::timestamptz group by 1",
    )
    .bind(&tz)
    .bind(iso(series_start))
    .fetch_all(db)
    .await?;
    let reply_rows: Vec<(Option<String>, i64)> = sqlx::query_as(
        "select to_char(timezone($1, received_at), 'YYYY-MM-DD'), count(*)::int8 from reach_messages
         where direction = 'in' and kind = 'reply' and received_at >= $2::timestamptz group by 1",
    )
    .bind(&tz)
    .bind(iso(series_start))
    .fetch_all(db)
    .await?;
    let interested: i64 = sqlx::query_scalar(
        "select count(*) from reach_messages where direction = 'in' and kind = 'reply'
             and label in ('interested', 'meeting_request') and received_at >= $1::timestamptz",
    )
    .bind(iso(window_start))
    .fetch_one(db)
    .await?;
    let bounced: i64 = sqlx::query_scalar(
        "select count(*) from reach_enrollments where status = 'bounced' and updated_at >= $1::timestamptz",
    )
    .bind(iso(window_start))
    .fetch_one(db)
    .await?;
    let active_campaigns: i64 = sqlx::query_scalar(
        "select count(*) from reach_campaigns where status = 'active' and deleted_at is null",
    )
    .fetch_one(db)
    .await?;
    let mailbox_rows: Vec<(String, i64)> = sqlx::query_as(
        "select status, count(*) from reach_mailboxes where deleted_at is null and status <> 'deleted' group by status",
    )
    .fetch_all(db)
    .await?;
    let unread: i64 = sqlx::query_scalar(
        "select count(*) from reach_messages where direction = 'in' and kind = 'reply' and read_at is null",
    )
    .fetch_one(db)
    .await?;
    let count_on = |rows: &[(Option<String>, i64)], date: &str| {
        rows.iter()
            .find(|(d, _)| d.as_deref() == Some(date))
            .map_or(0, |(_, n)| *n)
    };
    let daily: Vec<(String, i64, i64)> = day_starts
        .iter()
        .map(|start| {
            let date = local_date_key(add_minutes(*start, 12 * 60), &tz);
            let sent = count_on(&sent_rows, &date);
            let replies = count_on(&reply_rows, &date);
            (date, sent, replies)
        })
        .collect();
    let window = &daily[daily.len() - WINDOW_DAYS..];
    let sent7d: i64 = window.iter().map(|d| d.1).sum();
    let replies7d: i64 = window.iter().map(|d| d.2).sum();
    let (mut active, mut warming, mut paused, mut error) = (0, 0, 0, 0);
    for (status, n) in mailbox_rows {
        match status.as_str() {
            "active" => active += n,
            "warming" => warming += n,
            "paused" | "suspended" => paused += n,
            "error" => error += n,
            _ => {}
        }
    }
    Ok(json!({
        "sentToday": daily.last().map_or(0, |d| d.1),
        "sent7d": sent7d,
        "replies7d": replies7d,
        "interested7d": interested,
        "bounceRate7d": number(ratio(bounced, sent7d)),
        "replyRate7d": number(ratio(replies7d, sent7d)),
        "activeCampaigns": active_campaigns,
        "mailboxes": { "active": active, "warming": warming, "paused": paused, "error": error },
        "unreadReplies": unread,
        "daily": daily.iter().map(|(date, sent, replies)| json!({ "date": date, "sent": sent, "replies": replies })).collect::<Vec<_>>(),
    }))
}

/// A ratio as JavaScript prints it: whole values as integers.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratios_round_like_math_round() {
        assert!((ratio(1, 3) - 0.3333).abs() < f64::EPSILON);
        assert!((ratio(5, 3) - 1.0).abs() < f64::EPSILON);
        assert!((ratio(1, 0)).abs() < f64::EPSILON);
    }
}
