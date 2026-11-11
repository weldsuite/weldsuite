//! When a scheduled WeldDesk report runs next
//! (`apps/workers/desk-api/src/services/desk-report-schedules.ts`,
//! `nextReportRun`): every day, on a weekday or on a day of the month, at a
//! whole hour read in the schedule's own time zone.
//!
//! The arithmetic is the worker's, step for step, on the zone's offset at an
//! instant (what `Intl.DateTimeFormat` answers there, the IANA database jiff
//! bundles here), so both backends give the same instant across daylight
//! saving changes: a time that happens twice is the first one, a time that is
//! skipped is the moment the clock jumps.

use jiff::Timestamp;
use jiff::tz::TimeZone;

use crate::sla_calendar::offset_zone;

/// The due index kind the report sweep keeps (`desk_report`).
pub const DUE_KIND: &str = "desk_report";

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// `ReportTiming['frequency']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
}

impl Frequency {
    /// The stored value (`daily`, `weekly`, `monthly`).
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "daily" => Some(Self::Daily),
            "weekly" => Some(Self::Weekly),
            "monthly" => Some(Self::Monthly),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
        }
    }
}

/// `ReportTiming`: the fields of a schedule that decide when it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportTiming {
    pub frequency: Frequency,
    /// Weekly: 0 = Sunday … 6 = Saturday.
    pub day_of_week: Option<i64>,
    /// Monthly: 1 … 28.
    pub day_of_month: Option<i64>,
    /// 0 … 23, read in `timezone`.
    pub hour: i64,
    /// IANA zone.
    pub timezone: String,
}

/// The zone `Intl.DateTimeFormat` would use for `name`: an IANA name (any
/// case) or an offset (`+01:00`); `None` where `Intl` throws.
pub fn time_zone(name: &str) -> Option<TimeZone> {
    if name.is_empty() {
        return None;
    }
    TimeZone::get(name).ok().or_else(|| offset_zone(name))
}

/// `isTimeZone(value)` of the schedule schemas: whether `Intl` knows the zone.
pub fn is_time_zone(name: &str) -> bool {
    time_zone(name).is_some()
}

/// `zoneOffset(instant, timeZone)`: milliseconds the zone is ahead of UTC at
/// `instant`. The wall clock is whole seconds, so the milliseconds are
/// dropped first.
fn zone_offset(instant: i64, zone: &TimeZone) -> Option<i64> {
    let whole = instant.div_euclid(1000);
    let at = Timestamp::from_second(whole).ok()?;
    Some(i64::from(zone.to_offset(at).seconds()) * 1000)
}

/// `wallClockAsUtc(instant, timeZone)`: the wall clock of `instant` in the
/// zone, read back as if it were UTC.
fn wall_clock_as_utc(instant: i64, zone: &TimeZone) -> Option<i64> {
    Some(instant.div_euclid(1000) * 1000 + zone_offset(instant, zone)?)
}

/// `zonedInstant(year, month, day, hour, timeZone)` for the local day that
/// starts at `day_start` (a UTC-midnight time value): the instant at which
/// the zone's wall clock reads that day at `hour:00`.
fn zoned_instant(day_start: i64, hour: i64, zone: &TimeZone) -> Option<i64> {
    let wall = day_start + hour * HOUR_MS;
    let before = zone_offset(wall - DAY_MS, zone)?;
    let after = zone_offset(wall + DAY_MS, zone)?;
    let mut earliest: Option<i64> = None;
    for candidate in [wall - before, wall - after] {
        if zone_offset(candidate, zone)? == wall - candidate {
            earliest = Some(earliest.map_or(candidate, |found| found.min(candidate)));
        }
    }
    Some(earliest.unwrap_or(wall - before))
}

/// `getUTCDay()` of a UTC-midnight time value: 0 = Sunday.
fn weekday(day_start: i64) -> i64 {
    // 1970-01-01 was a Thursday.
    (day_start.div_euclid(DAY_MS) + 4).rem_euclid(7)
}

/// `getUTCDate()` of a UTC-midnight time value.
fn day_of_month(day_start: i64) -> Option<i64> {
    let at = Timestamp::from_second(day_start.div_euclid(1000)).ok()?;
    Some(i64::from(at.to_zoned(TimeZone::UTC).date().day()))
}

/// `nextReportRun(timing, after)`: the next moment strictly after `after`
/// (a time value in milliseconds) that falls on the schedule's day at
/// `hour:00` in its time zone. `Err` where the worker throws: a zone `Intl`
/// does not know, or a timing no day matches (a weekly schedule without a
/// weekday).
pub fn next_report_run(timing: &ReportTiming, after: i64) -> Result<i64, String> {
    let zone = time_zone(&timing.timezone)
        .ok_or_else(|| format!("Invalid time zone specified: {}", timing.timezone))?;
    let out_of_range = || "Invalid time value".to_owned();
    let local = wall_clock_as_utc(after, &zone).ok_or_else(out_of_range)?;
    let today = local.div_euclid(DAY_MS) * DAY_MS;
    // A month has at most 31 days, so a monthly schedule matches within 32 days of any start.
    for ahead in 0..=32 {
        let candidate = today + ahead * DAY_MS;
        let matches = match timing.frequency {
            Frequency::Daily => true,
            Frequency::Weekly => Some(weekday(candidate)) == timing.day_of_week,
            Frequency::Monthly => {
                timing.day_of_month.is_some() && day_of_month(candidate) == timing.day_of_month
            }
        };
        if !matches {
            continue;
        }
        let instant = zoned_instant(candidate, timing.hour, &zone).ok_or_else(out_of_range)?;
        if instant > after {
            return Ok(instant);
        }
    }
    let day = timing
        .day_of_week
        .or(timing.day_of_month)
        .map_or_else(|| "null".to_owned(), |day| day.to_string());
    Err(format!(
        "No next run for the {} schedule (day {day})",
        timing.frequency.as_str()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sla_calendar::iso;

    fn timing() -> ReportTiming {
        ReportTiming {
            frequency: Frequency::Daily,
            day_of_week: None,
            day_of_month: None,
            hour: 8,
            timezone: "UTC".to_owned(),
        }
    }

    fn in_zone(zone: &str) -> ReportTiming {
        ReportTiming {
            timezone: zone.to_owned(),
            ..timing()
        }
    }

    fn weekly(day: i64) -> ReportTiming {
        ReportTiming {
            frequency: Frequency::Weekly,
            day_of_week: Some(day),
            ..timing()
        }
    }

    fn monthly(day: i64) -> ReportTiming {
        ReportTiming {
            frequency: Frequency::Monthly,
            day_of_month: Some(day),
            ..timing()
        }
    }

    /// `new Date(text).getTime()` of an ISO instant.
    fn ms(text: &str) -> i64 {
        let at: Timestamp = text.parse().expect("an ISO instant");
        at.as_millisecond()
    }

    fn next(timing: &ReportTiming, after: &str) -> String {
        iso(next_report_run(timing, ms(after)).expect("a next run"))
    }

    // The cases of apps/workers/desk-api/src/services/desk-report-schedules.test.ts.

    #[test]
    fn daily_is_today_at_the_hour_when_that_is_still_ahead_else_tomorrow() {
        assert_eq!(
            next(&timing(), "2026-03-10T07:59:59Z"),
            "2026-03-10T08:00:00.000Z"
        );
        assert_eq!(
            next(&timing(), "2026-03-10T08:00:00Z"),
            "2026-03-11T08:00:00.000Z"
        );
        assert_eq!(
            next(&timing(), "2026-03-10T08:00:00.001Z"),
            "2026-03-11T08:00:00.000Z"
        );
    }

    #[test]
    fn daily_reads_the_day_and_hour_in_the_time_zone() {
        let amsterdam = in_zone("Europe/Amsterdam");
        assert_eq!(
            next(&amsterdam, "2026-03-10T22:00:00Z"),
            "2026-03-11T07:00:00.000Z"
        );
        assert_eq!(
            next(&amsterdam, "2026-03-10T04:00:00Z"),
            "2026-03-10T07:00:00.000Z"
        );
        assert_eq!(
            next(&in_zone("America/New_York"), "2026-03-10T02:00:00Z"),
            "2026-03-10T12:00:00.000Z"
        );
    }

    #[test]
    fn keeps_the_local_hour_when_the_clocks_go_forward() {
        let amsterdam = in_zone("Europe/Amsterdam");
        assert_eq!(
            next(&amsterdam, "2026-03-27T10:00:00Z"),
            "2026-03-28T07:00:00.000Z"
        );
        assert_eq!(
            next(&amsterdam, "2026-03-28T08:00:00Z"),
            "2026-03-29T06:00:00.000Z"
        );
        assert_eq!(
            next(&amsterdam, "2026-03-29T06:00:00Z"),
            "2026-03-30T06:00:00.000Z"
        );
    }

    #[test]
    fn keeps_the_local_hour_when_the_clocks_go_back() {
        let amsterdam = in_zone("Europe/Amsterdam");
        assert_eq!(
            next(&amsterdam, "2026-10-24T10:00:00Z"),
            "2026-10-25T07:00:00.000Z"
        );
        assert_eq!(
            next(&amsterdam, "2026-10-25T07:00:00Z"),
            "2026-10-26T07:00:00.000Z"
        );
    }

    #[test]
    fn runs_a_skipped_hour_at_the_moment_the_clock_jumps() {
        let two = ReportTiming {
            hour: 2,
            ..in_zone("Europe/Amsterdam")
        };
        assert_eq!(
            next(&two, "2026-03-28T12:00:00Z"),
            "2026-03-29T01:00:00.000Z"
        );
    }

    #[test]
    fn runs_a_repeated_hour_the_first_time_it_happens() {
        let two = ReportTiming {
            hour: 2,
            ..in_zone("Europe/Amsterdam")
        };
        assert_eq!(
            next(&two, "2026-10-24T12:00:00Z"),
            "2026-10-25T00:00:00.000Z"
        );
        assert_eq!(
            next(&two, "2026-10-25T00:00:00Z"),
            "2026-10-26T01:00:00.000Z"
        );
    }

    #[test]
    fn follows_the_united_states_change_on_another_date() {
        let new_york = in_zone("America/New_York");
        assert_eq!(
            next(&new_york, "2026-03-07T20:00:00Z"),
            "2026-03-08T12:00:00.000Z"
        );
        assert_eq!(
            next(&new_york, "2026-03-08T12:00:00Z"),
            "2026-03-09T12:00:00.000Z"
        );
    }

    #[test]
    fn weekly_is_the_next_weekday_strictly_after_the_given_moment() {
        // 2026-03-23 is a Monday.
        let monday = ReportTiming {
            hour: 9,
            timezone: "Europe/Amsterdam".to_owned(),
            ..weekly(1)
        };
        assert_eq!(
            next(&monday, "2026-03-23T07:59:59Z"),
            "2026-03-23T08:00:00.000Z"
        );
        assert_eq!(
            next(&monday, "2026-03-23T08:00:00Z"),
            "2026-03-30T07:00:00.000Z"
        );
        assert_eq!(
            next(&monday, "2026-03-24T12:00:00Z"),
            "2026-03-30T07:00:00.000Z"
        );
    }

    #[test]
    fn weekly_counts_sunday_as_0_and_saturday_as_6() {
        assert_eq!(
            next(&weekly(0), "2026-03-23T00:00:00Z"),
            "2026-03-29T08:00:00.000Z"
        );
        assert_eq!(
            next(&weekly(6), "2026-03-23T00:00:00Z"),
            "2026-03-28T08:00:00.000Z"
        );
    }

    #[test]
    fn weekly_uses_the_weekday_of_the_time_zone() {
        let auckland = ReportTiming {
            hour: 0,
            timezone: "Pacific/Auckland".to_owned(),
            ..weekly(1)
        };
        assert_eq!(
            next(&auckland, "2026-03-22T10:30:00Z"),
            "2026-03-22T11:00:00.000Z"
        );
        assert_eq!(
            next(&auckland, "2026-03-22T12:00:00Z"),
            "2026-03-29T11:00:00.000Z"
        );
    }

    #[test]
    fn monthly_is_the_day_of_the_month_at_the_hour() {
        let fifteenth = monthly(15);
        assert_eq!(
            next(&fifteenth, "2026-03-10T00:00:00Z"),
            "2026-03-15T08:00:00.000Z"
        );
        assert_eq!(
            next(&fifteenth, "2026-03-15T08:00:00Z"),
            "2026-04-15T08:00:00.000Z"
        );
    }

    #[test]
    fn monthly_reaches_the_28th_in_february_and_carries_on() {
        let last = monthly(28);
        assert_eq!(
            next(&last, "2026-01-31T12:00:00Z"),
            "2026-02-28T08:00:00.000Z"
        );
        assert_eq!(
            next(&last, "2026-02-28T08:00:00Z"),
            "2026-03-28T08:00:00.000Z"
        );
        assert_eq!(
            next(&last, "2028-02-10T00:00:00Z"),
            "2028-02-28T08:00:00.000Z"
        );
    }

    #[test]
    fn monthly_starts_from_the_end_of_a_month_and_rolls_over_the_year() {
        let first = monthly(1);
        assert_eq!(
            next(&first, "2026-01-31T23:00:00Z"),
            "2026-02-01T08:00:00.000Z"
        );
        assert_eq!(
            next(&first, "2026-12-31T23:00:00Z"),
            "2027-01-01T08:00:00.000Z"
        );
    }

    #[test]
    fn monthly_reads_the_month_day_in_the_time_zone() {
        let la = ReportTiming {
            hour: 20,
            timezone: "America/Los_Angeles".to_owned(),
            ..monthly(28)
        };
        assert_eq!(
            next(&la, "2026-03-01T03:00:00Z"),
            "2026-03-01T04:00:00.000Z"
        );
    }

    #[test]
    fn monthly_keeps_the_local_hour_across_a_daylight_saving_change() {
        let amsterdam = |day| ReportTiming {
            timezone: "Europe/Amsterdam".to_owned(),
            ..monthly(day)
        };
        assert_eq!(
            next(&amsterdam(28), "2026-03-01T00:00:00Z"),
            "2026-03-28T07:00:00.000Z"
        );
        assert_eq!(
            next(&amsterdam(1), "2026-03-02T00:00:00Z"),
            "2026-04-01T06:00:00.000Z"
        );
    }

    // What the routes' tests expect (schedules.integration.test.ts).

    #[test]
    fn the_route_cases() {
        let monday = ReportTiming {
            hour: 9,
            timezone: "Europe/Amsterdam".to_owned(),
            ..weekly(1)
        };
        // Sunday 15 March 2026, 12:00 UTC.
        assert_eq!(
            next(&monday, "2026-03-15T12:00:00Z"),
            "2026-03-16T08:00:00.000Z"
        );
        let end_of_month = ReportTiming {
            hour: 7,
            ..monthly(28)
        };
        assert_eq!(
            next(&end_of_month, "2026-03-15T12:00:00Z"),
            "2026-03-28T07:00:00.000Z"
        );
    }

    #[test]
    fn zones_are_known_as_intl_knows_them() {
        for zone in [
            "UTC",
            "utc",
            "Europe/Amsterdam",
            "europe/amsterdam",
            "America/New_York",
            "+01:00",
            "+0100",
            "+01",
        ] {
            assert!(is_time_zone(zone), "{zone}");
        }
        for zone in ["", "Mars/Olympus", "Nowhere/Land", "-5", "+25:00"] {
            assert!(!is_time_zone(zone), "{zone}");
        }
    }

    #[test]
    fn a_timing_without_its_day_has_no_next_run() {
        let weekly = ReportTiming {
            frequency: Frequency::Weekly,
            ..timing()
        };
        assert_eq!(
            next_report_run(&weekly, ms("2026-03-15T12:00:00Z")),
            Err("No next run for the weekly schedule (day null)".to_owned())
        );
        assert!(next_report_run(&in_zone("Mars/Olympus"), 0).is_err());
    }
}
