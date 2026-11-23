//! `overview.ts`: the overview numbers, and the "sent today" counts the send
//! engine shares. "Today" starts at midnight in the workspace's default
//! time zone.

use std::collections::HashMap;

use sea_orm::sea_query::{Alias, Asterisk, Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_schema::tenant::{
    reach_campaigns, reach_enrollments, reach_mailboxes, reach_messages as messages,
};

use crate::send_window::{add_minutes, start_of_zoned_day, utc_ms, zoned_midnight, zoned_parts};
use crate::{ReachResult, from_epoch_ms, stamp};

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
    use messages::Column;
    let day_start = stamp(day_start);
    let rows: Vec<(String, Option<String>, i64)> = messages::Entity::find()
        .select_only()
        .column(Column::MailboxId)
        .column(Column::CampaignId)
        .expr(Func::count(Expr::col(Asterisk)))
        .filter(Column::Direction.eq("out"))
        .filter(
            Condition::any().add(Column::SentAt.gte(day_start)).add(
                Condition::all()
                    .add(Column::SentAt.is_null())
                    .add(Column::Status.is_in(["sending", "unknown"]))
                    .add(Column::CreatedAt.gte(day_start)),
            ),
        )
        .group_by(Column::MailboxId)
        .group_by(Column::CampaignId)
        .into_tuple()
        .all(&orm(db))
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

/// `select to_char(timezone(tz, <at>), 'YYYY-MM-DD') as day, count(*) …
/// group by day` over the messages `filter` keeps.
async fn count_by_local_day(
    db: &DatabaseConnection,
    tz: &str,
    at: messages::Column,
    filter: Condition,
) -> Result<Vec<(Option<String>, i64)>, DbErr> {
    let day = Func::cust("to_char")
        .arg(
            Func::cust("timezone")
                .arg(tz)
                .arg(Expr::col((messages::Entity, at))),
        )
        .arg("YYYY-MM-DD");
    messages::Entity::find()
        .select_only()
        .column_as(Expr::from(day), "day")
        .expr(Func::count(Expr::col(Asterisk)))
        .filter(filter)
        .group_by(Expr::col(Alias::new("day")))
        .into_tuple()
        .all(db)
        .await
}

fn local_date_key(at: OffsetDateTime, timezone: &str) -> String {
    let p = zoned_parts(at, timezone);
    format!("{}-{:02}-{:02}", p.year, p.month, p.day)
}

/// `buildOverview(db, now)`.
pub async fn build(db: &PgPool, now: OffsetDateTime) -> ReachResult<Value> {
    use messages::Column;
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
    let conn = orm(db);
    let series_start = stamp(series_start);
    let window_start = stamp(window_start);
    let sent_rows = count_by_local_day(
        &conn,
        &tz,
        Column::SentAt,
        Condition::all()
            .add(Column::Direction.eq("out"))
            .add(Column::Status.eq("sent"))
            .add(Column::SentAt.gte(series_start)),
    )
    .await?;
    let reply_rows = count_by_local_day(
        &conn,
        &tz,
        Column::ReceivedAt,
        Condition::all()
            .add(Column::Direction.eq("in"))
            .add(Column::Kind.eq("reply"))
            .add(Column::ReceivedAt.gte(series_start)),
    )
    .await?;
    let interested = messages::Entity::find()
        .filter(Column::Direction.eq("in"))
        .filter(Column::Kind.eq("reply"))
        .filter(Column::Label.is_in(["interested", "meeting_request"]))
        .filter(Column::ReceivedAt.gte(window_start))
        .count(&conn)
        .await?;
    let bounced = reach_enrollments::Entity::find()
        .filter(reach_enrollments::Column::Status.eq("bounced"))
        .filter(reach_enrollments::Column::UpdatedAt.gte(window_start))
        .count(&conn)
        .await?;
    let bounced = i64::try_from(bounced).unwrap_or(i64::MAX);
    let active_campaigns = reach_campaigns::Entity::find()
        .filter(reach_campaigns::Column::Status.eq("active"))
        .filter(reach_campaigns::Column::DeletedAt.is_null())
        .count(&conn)
        .await?;
    let mailbox_rows: Vec<(String, i64)> = reach_mailboxes::Entity::find()
        .select_only()
        .column(reach_mailboxes::Column::Status)
        .expr(Func::count(Expr::col(Asterisk)))
        .filter(reach_mailboxes::Column::DeletedAt.is_null())
        .filter(reach_mailboxes::Column::Status.ne("deleted"))
        .group_by(reach_mailboxes::Column::Status)
        .into_tuple()
        .all(&conn)
        .await?;
    let unread = messages::Entity::find()
        .filter(Column::Direction.eq("in"))
        .filter(Column::Kind.eq("reply"))
        .filter(Column::ReadAt.is_null())
        .count(&conn)
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
