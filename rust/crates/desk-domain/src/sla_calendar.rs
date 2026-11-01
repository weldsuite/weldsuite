//! Business-time arithmetic for WeldDesk SLA clocks
//! (`@weldsuite/db/lib/desk-sla-calendar`,
//! `packages/core/db/src/lib/desk-sla-calendar.ts`).
//!
//! A calendar is the `BusinessHours` shape SLA policies and helpdesk
//! settings store: a timezone, open/close times per weekday and holidays.
//! `None` means 24x7, where business time is wall-clock time. Instants are
//! JavaScript time values (milliseconds since the epoch); the local time of
//! an instant is what `Intl.DateTimeFormat` prints for it (to the second),
//! computed from the IANA database jiff bundles.

use std::collections::HashSet;

use jiff::Timestamp;
use jiff::tz::{Offset, TimeZone};
use serde_json::Value;

const DAY_KEYS: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const DAY_MINUTES: i64 = 24 * 60;
/// Ten years of days: a calendar that never opens again stops the search here.
const MAX_DAYS: usize = 3660;

/// An open window, in minutes after local midnight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OpenWindow {
    open: i64,
    close: i64,
}

/// `DeskSlaCalendar`.
#[derive(Debug, Clone)]
pub struct SlaCalendar {
    timezone: TimeZone,
    /// Indexed by the local date's weekday: 0 = Sunday.
    days: [Option<OpenWindow>; 7],
    holidays: HashSet<String>,
    recurring_holidays: HashSet<String>,
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `parseClock(value)`: `/^(\d{1,2}):(\d{2})/` on the trimmed text, as
/// minutes after midnight (at most 24:00).
fn parse_clock(value: Option<&Value>) -> Option<i64> {
    if !truthy(value) {
        return None;
    }
    // A value that isn't text makes TypeScript's `.trim()` throw; it never
    // comes from the settings forms.
    let text = weldsuite_kit::validation::js_trim(value?.as_str()?);
    let bytes = text.as_bytes();
    let hour_len = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if hour_len == 0 {
        return None;
    }
    // `\d{1,2}` backtracks: "123:45" has no match, "1:23" and "12:34" do.
    if hour_len > 2 {
        return None;
    }
    let rest = &bytes[hour_len..];
    if rest.len() < 3 || rest[0] != b':' || !rest[1].is_ascii_digit() || !rest[2].is_ascii_digit()
    {
        return None;
    }
    let hours: i64 = text[..hour_len].parse().ok()?;
    let minutes = i64::from(rest[1] - b'0') * 10 + i64::from(rest[2] - b'0');
    let total = hours * 60 + minutes;
    (0..=DAY_MINUTES).contains(&total).then_some(total)
}

/// `±HH`, `±HHMM` or `±HH:MM`: an offset time zone, as `Intl` takes it.
fn offset_zone(text: &str) -> Option<TimeZone> {
    let sign = match text.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits = &text[1..];
    let (hours, minutes) = match digits.len() {
        2 => (digits, "00"),
        4 => (&digits[..2], &digits[2..]),
        5 if digits.as_bytes()[2] == b':' => (&digits[..2], &digits[3..]),
        _ => return None,
    };
    if !hours.bytes().chain(minutes.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hours: i32 = hours.parse().ok()?;
    let minutes: i32 = minutes.parse().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Offset::from_seconds(sign * (hours * 3600 + minutes * 60))
        .ok()
        .map(TimeZone::fixed)
}

/// `validTimezone(timezone)`: the zone `Intl` would use, else UTC.
fn valid_timezone(value: Option<&Value>) -> TimeZone {
    if !truthy(value) {
        return TimeZone::UTC;
    }
    let Some(name) = value.and_then(Value::as_str) else {
        return TimeZone::UTC;
    };
    TimeZone::get(name)
        .ok()
        .or_else(|| offset_zone(name))
        .unwrap_or(TimeZone::UTC)
}

/// `/^\d{4}-\d{2}-\d{2}/.exec(text)?.[0]`.
fn iso_date_prefix(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let shape = bytes[..10].iter().enumerate().all(|(i, b)| match i {
        4 | 7 => *b == b'-',
        _ => b.is_ascii_digit(),
    });
    shape.then(|| &text[..10])
}

/// `toDeskSlaCalendar(hours)`: stored business hours, normalised. `None`
/// (24x7) when there are none or no weekday is ever open, so a misconfigured
/// calendar can never stop a clock for good.
pub fn to_calendar(hours: &Value) -> Option<SlaCalendar> {
    if !truthy(Some(hours)) {
        return None;
    }
    let mut days = [None; 7];
    for (index, key) in DAY_KEYS.iter().enumerate() {
        let day = hours.get(key);
        if !truthy(day.and_then(|d| d.get("isOpen"))) {
            continue;
        }
        let day = day.unwrap_or(&Value::Null);
        let open = parse_clock(day.get("openTime")).unwrap_or(0);
        let close_raw = parse_clock(day.get("closeTime")).unwrap_or(DAY_MINUTES);
        // An overnight window (close before open) runs to midnight.
        let close = if close_raw > open {
            close_raw
        } else {
            DAY_MINUTES
        };
        if close > open {
            days[index] = Some(OpenWindow { open, close });
        }
    }
    if days.iter().all(Option::is_none) {
        return None;
    }
    let mut holidays = HashSet::new();
    let mut recurring_holidays = HashSet::new();
    if let Some(list) = hours.get("holidays").and_then(Value::as_array) {
        for holiday in list {
            let Some(date) = holiday
                .get("date")
                .and_then(Value::as_str)
                .and_then(iso_date_prefix)
            else {
                continue;
            };
            if truthy(holiday.get("isRecurring")) {
                recurring_holidays.insert(date[5..].to_owned());
            } else {
                holidays.insert(date.to_owned());
            }
        }
    }
    Some(SlaCalendar {
        timezone: valid_timezone(hours.get("timezone")),
        days,
        holidays,
        recurring_holidays,
    })
}

/// `Math.floor(a / b)` on integers.
fn floor_div(a: i64, b: i64) -> i64 {
    a.div_euclid(b)
}

impl SlaCalendar {
    /// `localAsUtc(ms, timezone)`: the local wall-clock time at `ms`, to the
    /// second, as if it were UTC.
    fn local_as_utc(&self, ms: i64) -> i64 {
        let offset_ms = Timestamp::from_millisecond(ms)
            .map(|at| i64::from(self.timezone.to_offset(at).seconds()) * 1000)
            .unwrap_or(0);
        floor_div(ms + offset_ms, 1000) * 1000
    }

    /// `zonedToUtc(localDay, minutes, timezone)`: the instant at which local
    /// midnight of `local_day` plus `minutes` happens.
    fn zoned_to_utc(&self, local_day: i64, minutes: i64) -> i64 {
        let wall = local_day + minutes * 60_000;
        let offset = self.local_as_utc(wall) - wall;
        let mut instant = wall - offset;
        // Across a DST change the offset at the result can differ from the guess.
        let corrected = self.local_as_utc(instant) - instant;
        if corrected != offset {
            instant = wall - corrected;
        }
        instant
    }

    /// `openInterval(calendar, localDay)`: the open interval of a local day,
    /// or `None` when it is closed.
    fn open_interval(&self, local_day: i64) -> Option<(i64, i64)> {
        let days_since_epoch = floor_div(local_day, DAY_MS);
        // 1970-01-01 was a Thursday.
        let weekday = usize::try_from((days_since_epoch + 4).rem_euclid(7)).unwrap_or(0);
        let window = self.days[weekday]?;
        let key = date_key(local_day);
        if self.holidays.contains(&key) || self.recurring_holidays.contains(&key[5..]) {
            return None;
        }
        Some((
            self.zoned_to_utc(local_day, window.open),
            self.zoned_to_utc(local_day, window.close),
        ))
    }

    /// `localDayOf(ms, timezone)`: the UTC-midnight time value of the local
    /// date `ms` falls on.
    fn local_day_of(&self, ms: i64) -> i64 {
        let local = self.local_as_utc(ms);
        local - local.rem_euclid(DAY_MS)
    }
}

/// `new Date(ms).toISOString()`.
pub fn iso(ms: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .map(weldsuite_events::iso_timestamp)
        .unwrap_or_default()
}

/// `dateKey(localDay)`: `YYYY-MM-DD` of a UTC-midnight time value.
fn date_key(local_day: i64) -> String {
    let iso = iso(local_day);
    iso.get(..10).unwrap_or_default().to_owned()
}

/// `businessMsBetween(calendar, from, to)`: business milliseconds between
/// two instants (0 when `to` is not after `from`).
pub fn business_ms_between(calendar: Option<&SlaCalendar>, from: i64, to: i64) -> i64 {
    if to <= from {
        return 0;
    }
    let Some(calendar) = calendar else {
        return to - from;
    };
    let mut total = 0;
    // Start a day early: a window of the previous local day can't reach past
    // midnight, but DST shifts make "which local day" fuzzy at the edges.
    let mut day = calendar.local_day_of(from) - DAY_MS;
    for _ in 0..MAX_DAYS {
        if let Some((open, close)) = calendar.open_interval(day) {
            if open >= to {
                break;
            }
            let overlap = close.min(to) - open.max(from);
            if overlap > 0 {
                total += overlap;
            }
        } else if day - DAY_MS > to {
            break;
        }
        day += DAY_MS;
    }
    total
}

/// `new Date(ms)`: JavaScript's TimeClip truncates a fractional time value.
#[allow(clippy::cast_possible_truncation)]
fn date(ms: f64) -> i64 {
    ms.trunc() as i64
}

/// `addBusinessMs(calendar, from, ms)`: the instant `ms` of business time
/// after `from`. With a calendar, a clock that reaches 0 exactly at closing
/// time is due at closing time.
#[allow(clippy::cast_precision_loss)]
pub fn add_business_ms(calendar: Option<&SlaCalendar>, from: i64, ms: f64) -> i64 {
    // `ms <= 0` is false for NaN, which then runs the loop to its end.
    if ms <= 0.0 {
        return from;
    }
    let Some(calendar) = calendar else {
        return date(from as f64 + ms);
    };
    let mut remaining = ms;
    let mut day = calendar.local_day_of(from) - DAY_MS;
    for _ in 0..MAX_DAYS {
        if let Some((open, close)) = calendar.open_interval(day) {
            let open = open.max(from);
            if close > open {
                let span = (close - open) as f64;
                if span >= remaining {
                    return date(open as f64 + remaining);
                }
                remaining -= span;
            }
        }
        day += DAY_MS;
    }
    // Holidays closed every remaining day: fall back to wall-clock time.
    date(from as f64 + ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HOUR: i64 = 3_600_000;

    fn at(iso: &str) -> i64 {
        iso.parse::<Timestamp>().unwrap().as_millisecond()
    }

    fn office() -> SlaCalendar {
        let weekdays = json!({ "isOpen": true, "openTime": "09:00", "closeTime": "17:00" });
        to_calendar(&json!({
            "timezone": "Europe/Amsterdam",
            "monday": weekdays, "tuesday": weekdays, "wednesday": weekdays,
            "thursday": weekdays, "friday": weekdays,
            "holidays": [{ "date": "2026-12-25", "name": "Christmas", "isRecurring": true }],
        }))
        .unwrap()
    }

    #[test]
    fn counts_wall_clock_time_for_24x7() {
        assert_eq!(
            business_ms_between(None, at("2026-11-02T10:00:00Z"), at("2026-11-02T11:30:00Z")),
            HOUR * 3 / 2
        );
        #[allow(clippy::cast_precision_loss)]
        let hour = HOUR as f64;
        assert_eq!(
            add_business_ms(None, at("2026-11-02T10:00:00Z"), hour),
            at("2026-11-02T11:00:00Z")
        );
    }

    #[test]
    fn counts_open_hours_in_the_calendar_timezone() {
        let office = office();
        assert_eq!(
            business_ms_between(
                Some(&office),
                at("2026-11-02T15:00:00Z"),
                at("2026-11-03T09:00:00Z")
            ),
            2 * HOUR
        );
        #[allow(clippy::cast_precision_loss)]
        let two = (2 * HOUR) as f64;
        // Friday 16:00 CET + 2 business hours = Monday 10:00 CET.
        assert_eq!(
            add_business_ms(Some(&office), at("2026-11-06T15:00:00Z"), two),
            at("2026-11-09T09:00:00Z")
        );
        // Christmas (a recurring holiday) is closed.
        assert_eq!(
            add_business_ms(Some(&office), at("2026-12-24T15:00:00Z"), two),
            at("2026-12-28T09:00:00Z")
        );
    }

    #[test]
    fn follows_daylight_saving_time() {
        #[allow(clippy::cast_precision_loss)]
        let hour = HOUR as f64;
        assert_eq!(
            add_business_ms(Some(&office()), at("2026-03-30T06:00:00Z"), hour),
            at("2026-03-30T08:00:00Z")
        );
    }

    #[test]
    fn a_calendar_that_never_opens_is_24x7() {
        assert!(to_calendar(&json!({ "timezone": "UTC", "monday": { "isOpen": false } })).is_none());
        assert!(to_calendar(&Value::Null).is_none());
    }

    #[test]
    fn clocks_parse_like_the_regex() {
        assert_eq!(parse_clock(Some(&json!("09:30"))), Some(570));
        assert_eq!(parse_clock(Some(&json!(" 9:05pm"))), Some(545));
        assert_eq!(parse_clock(Some(&json!("24:00"))), Some(1440));
        assert_eq!(parse_clock(Some(&json!("24:01"))), None);
        assert_eq!(parse_clock(Some(&json!("123:45"))), None);
        assert_eq!(parse_clock(Some(&json!("9:5"))), None);
        assert_eq!(parse_clock(Some(&json!(""))), None);
    }

    #[test]
    fn unknown_timezones_are_utc() {
        let calendar = to_calendar(&json!({
            "timezone": "Mars/Olympus",
            "monday": { "isOpen": true, "openTime": "09:00", "closeTime": "10:00" },
        }))
        .unwrap();
        // Monday 2 Nov 2026 09:00 UTC.
        assert_eq!(
            business_ms_between(
                Some(&calendar),
                at("2026-11-02T00:00:00Z"),
                at("2026-11-03T00:00:00Z")
            ),
            HOUR
        );
    }
}
