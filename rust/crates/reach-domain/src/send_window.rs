//! `send-window.ts`: sending windows in a campaign's time zone. Instants are
//! milliseconds since the epoch, as JavaScript's `Date` keeps them; the zone
//! rules come from jiff's bundled tz database, as `Intl.DateTimeFormat`'s
//! come from the runtime's. The two-pass offset search of `zonedTimeToUtc`
//! is kept as written, so a time in a DST gap or overlap resolves the same.

use jiff::Timestamp;
use jiff::tz::TimeZone;
use time::OffsetDateTime;

use crate::{epoch_ms, from_epoch_ms};

const MINUTE_MS: i64 = 60_000;
const DAY_MINUTES: i64 = 24 * 60;
const MAX_LOOKAHEAD_DAYS: i64 = 14;

/// `SendSchedule`.
#[derive(Debug, Clone)]
pub struct SendSchedule {
    pub timezone: String,
    /// ISO weekdays 1 (Mon) .. 7 (Sun); empty means every day.
    pub send_days: Vec<i64>,
    pub window_start: String,
    pub window_end: String,
}

/// `ZonedParts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ZonedParts {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub iso_weekday: i64,
}

/// The zone, as `Intl.DateTimeFormat` would accept its name.
pub fn time_zone(name: &str) -> Option<TimeZone> {
    if name.is_empty() {
        return None;
    }
    TimeZone::get(name).ok()
}

/// `isValidTimeZone(name)`.
pub fn is_valid_time_zone(name: &str) -> bool {
    time_zone(name).is_some()
}

/// `Date.UTC(year, month - 1, day, hour, minute, second)` with JavaScript's
/// overflow of the day (and month) into the next ones.
pub fn utc_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    let months = year * 12 + (month - 1);
    let (whole_year, month_index) = (months.div_euclid(12), months.rem_euclid(12));
    let days = days_from_civil(whole_year, month_index + 1, 1) + (day - 1);
    ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The calendar date of a day count since the epoch.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn iso_weekday_of(year: i64, month: i64, day: i64) -> i64 {
    // 1970-01-01 was a Thursday (4).
    (days_from_civil(year, month, day) + 3).rem_euclid(7) + 1
}

/// The zone's offset (wall clock − UTC) at an instant, in milliseconds.
fn offset_ms(utc_ms: i64, zone: &TimeZone) -> i64 {
    let whole = utc_ms.div_euclid(1000) * 1000;
    Timestamp::from_millisecond(whole)
        .map(|ts| i64::from(zone.to_offset(ts).seconds()) * 1000)
        .unwrap_or_default()
}

/// `getZonedParts(date, timeZone)` on milliseconds.
pub fn zoned_parts_ms(ms: i64, zone: &TimeZone) -> ZonedParts {
    let local = ms.div_euclid(1000) * 1000 + offset_ms(ms, zone);
    let days = local.div_euclid(86_400_000);
    let rest = local.rem_euclid(86_400_000) / 1000;
    let (year, month, day) = civil_from_days(days);
    ZonedParts {
        year,
        month,
        day,
        hour: rest / 3600,
        minute: (rest / 60) % 60,
        second: rest % 60,
        iso_weekday: iso_weekday_of(year, month, day),
    }
}

/// `getZonedParts(date, timeZone)`; UTC for a zone it does not know.
pub fn zoned_parts(at: OffsetDateTime, timezone: &str) -> ZonedParts {
    let zone = time_zone(timezone).unwrap_or(TimeZone::UTC);
    zoned_parts_ms(epoch_ms(at), &zone)
}

/// `zonedTimeToUtc(local, timeZone)` on milliseconds.
pub fn zoned_time_to_utc_ms(
    (year, month, day): (i64, i64, i64),
    (hour, minute, second): (i64, i64, i64),
    zone: &TimeZone,
) -> i64 {
    let as_utc = utc_ms(year, month, day, hour, minute, second);
    let first = offset_ms(as_utc, zone);
    let mut utc = as_utc - first;
    let second_offset = offset_ms(utc, zone);
    if second_offset != first {
        utc = as_utc - second_offset;
    }
    utc
}

/// `zonedTimeToUtc({ year, month, day }, timeZone)` (midnight).
pub fn zoned_midnight(year: i64, month: i64, day: i64, timezone: &str) -> OffsetDateTime {
    let zone = time_zone(timezone).unwrap_or(TimeZone::UTC);
    from_epoch_ms(zoned_time_to_utc_ms((year, month, day), (0, 0, 0), &zone))
}

/// `parseHHMM(value)`.
pub fn parse_hhmm(value: &str) -> Option<i64> {
    let (h, m) = value.split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 || !h.bytes().chain(m.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (h, m): (i64, i64) = (h.parse().ok()?, m.parse().ok()?);
    (h <= 23 && m <= 59).then_some(h * 60 + m)
}

fn window_minutes(schedule: &SendSchedule) -> (i64, i64) {
    let start = parse_hhmm(&schedule.window_start).unwrap_or(9 * 60);
    let parsed_end = parse_hhmm(&schedule.window_end).unwrap_or(17 * 60);
    (start, if parsed_end <= start { DAY_MINUTES } else { parsed_end })
}

fn send_day_set(schedule: &SendSchedule) -> Vec<i64> {
    if schedule.send_days.is_empty() {
        vec![1, 2, 3, 4, 5, 6, 7]
    } else {
        schedule.send_days.clone()
    }
}

/// `shiftLocalDate(base, days)`: (year, month, day, isoWeekday).
fn shift_local_date(year: i64, month: i64, day: i64, days: i64) -> (i64, i64, i64, i64) {
    let (y, m, d) = civil_from_days(days_from_civil(year, month, 1) + day - 1 + days);
    (y, m, d, iso_weekday_of(y, m, d))
}

fn local_minutes_to_utc(date: (i64, i64, i64), minutes: i64, zone: &TimeZone) -> i64 {
    if minutes >= DAY_MINUTES {
        let (y, m, d, _) = shift_local_date(date.0, date.1, date.2, 1);
        return zoned_time_to_utc_ms((y, m, d), (0, 0, 0), zone);
    }
    zoned_time_to_utc_ms(date, (minutes / 60, minutes % 60, 0), zone)
}

/// `startOfZonedDay(date, timeZone)`.
pub fn start_of_zoned_day(at: OffsetDateTime, timezone: &str) -> OffsetDateTime {
    let zone = time_zone(timezone).unwrap_or(TimeZone::UTC);
    let p = zoned_parts_ms(epoch_ms(at), &zone);
    from_epoch_ms(zoned_time_to_utc_ms((p.year, p.month, p.day), (0, 0, 0), &zone))
}

/// `startOfNextZonedDay(date, timeZone)`.
pub fn start_of_next_zoned_day(at: OffsetDateTime, timezone: &str) -> OffsetDateTime {
    let zone = time_zone(timezone).unwrap_or(TimeZone::UTC);
    let p = zoned_parts_ms(epoch_ms(at), &zone);
    let (y, m, d, _) = shift_local_date(p.year, p.month, p.day, 1);
    from_epoch_ms(zoned_time_to_utc_ms((y, m, d), (0, 0, 0), &zone))
}

/// `snapIntoWindow(at, schedule)` on milliseconds.
pub fn snap_into_window_ms(at: i64, schedule: &SendSchedule) -> i64 {
    let zone = time_zone(&schedule.timezone).unwrap_or(TimeZone::UTC);
    let (start, end) = window_minutes(schedule);
    let days = send_day_set(schedule);
    let local = zoned_parts_ms(at, &zone);
    for offset in 0..=MAX_LOOKAHEAD_DAYS {
        let (y, m, d, weekday) = shift_local_date(local.year, local.month, local.day, offset);
        if !days.contains(&weekday) {
            continue;
        }
        let open = local_minutes_to_utc((y, m, d), start, &zone);
        let close = local_minutes_to_utc((y, m, d), end, &zone);
        if at >= close {
            continue;
        }
        return if at > open { at } else { open };
    }
    at
}

/// `snapIntoWindow(at, schedule)`.
pub fn snap_into_window(at: OffsetDateTime, schedule: &SendSchedule) -> OffsetDateTime {
    from_epoch_ms(snap_into_window_ms(epoch_ms(at), schedule))
}

/// `isWithinWindow(at, schedule)`.
pub fn is_within_window(at: OffsetDateTime, schedule: &SendSchedule) -> bool {
    snap_into_window_ms(epoch_ms(at), schedule) == epoch_ms(at)
}

/// `windowCloseOfDay(at, schedule)` on milliseconds.
pub fn window_close_of_day_ms(at: i64, schedule: &SendSchedule) -> i64 {
    let zone = time_zone(&schedule.timezone).unwrap_or(TimeZone::UTC);
    let (_, end) = window_minutes(schedule);
    let local = zoned_parts_ms(at, &zone);
    local_minutes_to_utc((local.year, local.month, local.day), end, &zone)
}

/// `spreadSendTimes(count, from, schedule, maxStepMs)`.
pub fn spread_send_times(count: usize, from: OffsetDateTime, schedule: &SendSchedule, max_step_ms: i64) -> Vec<OffsetDateTime> {
    if count == 0 {
        return Vec::new();
    }
    let first = snap_into_window_ms(epoch_ms(from), schedule);
    let remaining = (window_close_of_day_ms(first, schedule) - first).max(0);
    let step = if count > 1 {
        let per = remaining as f64 / count as f64;
        (per.min(max_step_ms as f64)).floor().max(0.0) as i64
    } else {
        0
    };
    (0..count)
        .map(|i| from_epoch_ms(snap_into_window_ms(first + i as i64 * step, schedule)))
        .collect()
}

/// `addMinutes(base, minutes)`.
pub fn add_minutes(base: OffsetDateTime, minutes: i64) -> OffsetDateTime {
    from_epoch_ms(epoch_ms(base) + minutes * MINUTE_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule() -> SendSchedule {
        SendSchedule {
            timezone: "Europe/Amsterdam".to_owned(),
            send_days: vec![1, 2, 3, 4, 5],
            window_start: "09:00".to_owned(),
            window_end: "17:00".to_owned(),
        }
    }

    #[test]
    fn dates_and_zones() {
        assert_eq!(utc_ms(2026, 1, 32, 0, 0, 0), utc_ms(2026, 2, 1, 0, 0, 0));
        assert_eq!(iso_weekday_of(2026, 11, 2), 1);
        let zone = time_zone("Europe/Amsterdam").expect("zone");
        // 2026-10-25 is the DST end in Europe: midnight is still +02:00.
        let midnight = zoned_time_to_utc_ms((2026, 10, 25), (0, 0, 0), &zone);
        assert_eq!(midnight, utc_ms(2026, 10, 24, 22, 0, 0));
        assert!(!is_valid_time_zone("Mars/Base"));
    }

    #[test]
    fn snapping() {
        // Saturday 2026-10-31 12:00 UTC snaps to Monday 09:00 Amsterdam (08:00 UTC).
        let at = utc_ms(2026, 10, 31, 12, 0, 0);
        assert_eq!(snap_into_window_ms(at, &schedule()), utc_ms(2026, 11, 2, 8, 0, 0));
        let inside = utc_ms(2026, 11, 2, 10, 0, 0);
        assert_eq!(snap_into_window_ms(inside, &schedule()), inside);
    }

    #[test]
    fn hhmm() {
        assert_eq!(parse_hhmm("9:05"), Some(545));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("0900"), None);
    }
}
