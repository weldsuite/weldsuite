//! Calendar-day boundaries in a time zone
//! (`@weldsuite/flow-domain/day-boundaries`): "today", "this week" and
//! "overdue" cut at the workspace's local midnight
//! (`workspace_settings.timezone`), not at UTC midnight.

use jiff::Timestamp;
use jiff::tz::TimeZone;
use sqlx::PgPool;

const DAY_MS: i64 = 86_400_000;

/// Local midnights, as epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayBounds {
    /// Local midnight that starts today: a due date before it is overdue.
    pub start_of_today: i64,
    /// Local midnight that ends today.
    pub start_of_tomorrow: i64,
    /// The Monday after tomorrow's weekday ("this week" runs from tomorrow
    /// up to it); a Sunday's is eight days out.
    pub start_of_next_week: i64,
}

/// The zone `new Intl.DateTimeFormat('en-US', { timeZone })` accepts, else
/// UTC.
fn zone_of(timezone: Option<&str>) -> TimeZone {
    timezone
        .filter(|name| !name.is_empty())
        .and_then(|name| TimeZone::get(name).ok())
        .unwrap_or(TimeZone::UTC)
}

/// `zoneOffsetMs(instant, timezone)`: how far the zone is ahead of UTC.
fn zone_offset_ms(instant: i64, zone: &TimeZone) -> i64 {
    let Ok(at) = Timestamp::from_millisecond(instant) else {
        return 0;
    };
    i64::from(zone.to_offset(at).seconds()) * 1000
}

/// `zonedMidnight(year, month, day, timezone)`: resolved twice, so a day
/// whose offset changes still lands on midnight.
fn zoned_midnight(naive: i64, zone: &TimeZone) -> i64 {
    let first = naive - zone_offset_ms(naive, zone);
    naive - zone_offset_ms(first, zone)
}

/// `dayBoundsInTimezone(timezone, now)`.
pub fn day_bounds_in_timezone(timezone: Option<&str>, now_ms: i64) -> DayBounds {
    let zone = zone_of(timezone);
    let today = Timestamp::from_millisecond(now_ms)
        .map(|at| at.to_zoned(zone.clone()).date())
        .unwrap_or_default();
    let today_utc = crate::js::days_from_civil(
        i64::from(today.year()),
        i64::from(today.month()),
        i64::from(today.day()),
    ) * DAY_MS;
    let at = |offset_days: i64| zoned_midnight(today_utc + offset_days * DAY_MS, &zone);
    // `getUTCDay()` of tomorrow: 1970-01-01 was a Thursday.
    let tomorrow_weekday = ((today_utc + DAY_MS).div_euclid(DAY_MS) + 4).rem_euclid(7);
    let until_monday = match (1 - tomorrow_weekday + 7) % 7 {
        0 => 7,
        days => days,
    };
    DayBounds {
        start_of_today: at(0),
        start_of_tomorrow: at(1),
        start_of_next_week: at(1 + until_monday),
    }
}

/// `getWorkspaceTimezone(db)`: the workspace's zone, `None` when unset.
pub async fn workspace_timezone(db: &PgPool) -> Result<Option<String>, sqlx::Error> {
    let zone: Option<Option<String>> =
        sqlx::query_scalar("select timezone from workspace_settings limit 1")
            .fetch_optional(db)
            .await?;
    Ok(zone.flatten().filter(|zone| !zone.is_empty()))
}

/// `workspaceDayBounds(db, now)`.
pub async fn workspace_day_bounds(db: &PgPool, now_ms: i64) -> Result<DayBounds, sqlx::Error> {
    Ok(day_bounds_in_timezone(
        workspace_timezone(db).await?.as_deref(),
        now_ms,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(iso: &str) -> i64 {
        crate::js::js_date_millis(iso).expect("date")
    }

    #[test]
    fn utc_cuts_at_utc_midnight() {
        // A Wednesday.
        let bounds = day_bounds_in_timezone(Some("UTC"), ms("2026-03-04T10:00:00Z"));
        assert_eq!(bounds.start_of_today, ms("2026-03-04T00:00:00Z"));
        assert_eq!(bounds.start_of_tomorrow, ms("2026-03-05T00:00:00Z"));
        assert_eq!(bounds.start_of_next_week, ms("2026-03-09T00:00:00Z"));
    }

    #[test]
    fn a_zone_ahead_of_utc_starts_its_day_earlier() {
        let bounds = day_bounds_in_timezone(Some("Europe/Amsterdam"), ms("2026-03-04T23:30:00Z"));
        // 00:30 on Thursday in Amsterdam (UTC+1).
        assert_eq!(bounds.start_of_today, ms("2026-03-04T23:00:00Z"));
        assert_eq!(bounds.start_of_tomorrow, ms("2026-03-05T23:00:00Z"));
    }

    #[test]
    fn saturday_and_sunday_reach_the_next_monday() {
        // Saturday: tomorrow is Sunday, next Monday is two days out.
        let saturday = day_bounds_in_timezone(None, ms("2026-03-07T12:00:00Z"));
        assert_eq!(saturday.start_of_next_week, ms("2026-03-09T00:00:00Z"));
        // Sunday: tomorrow is Monday, so "next week" starts the Monday after.
        let sunday = day_bounds_in_timezone(None, ms("2026-03-08T12:00:00Z"));
        assert_eq!(sunday.start_of_next_week, ms("2026-03-16T00:00:00Z"));
    }

    #[test]
    fn an_unknown_zone_is_utc() {
        let bounds = day_bounds_in_timezone(Some("Mars/Olympus"), ms("2026-03-04T10:00:00Z"));
        assert_eq!(bounds.start_of_today, ms("2026-03-04T00:00:00Z"));
    }
}
