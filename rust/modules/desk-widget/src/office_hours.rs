//! `lib/office-hours.ts`: is the team in right now, and if not, when are they
//! back? Windows are wall-clock times in the widget's IANA time zone; the
//! widget gets the answer from `/api/config`, never the schedule.

use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde_json::{Value, json};
use time::OffsetDateTime;

/// Indexed like `Date#getDay()`: Sunday first.
const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MINUTES: i64 = 24 * 60;
const MINUTE_MS: i64 = 60_000;

/// `minutesOf(time)`: `HH:MM` as minutes since midnight, `24:00` included.
fn minutes_of(time: &str) -> Option<i64> {
    let bytes = time.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = &time[range];
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let hours = digits(0..2)?;
    let minutes = digits(3..5)?;
    if minutes > 59 {
        return None;
    }
    let total = hours * 60 + minutes;
    (total <= DAY_MINUTES).then_some(total)
}

/// `isValidTimeZone(zone)`: a zone `Intl.DateTimeFormat` accepts.
fn time_zone(zone: Option<&str>) -> TimeZone {
    zone.filter(|zone| !zone.is_empty())
        .and_then(|zone| TimeZone::get(zone).ok())
        .unwrap_or(TimeZone::UTC)
}

/// `localClock(at, timeZone)`: the weekday (0 = Sunday) and minutes since
/// midnight at `at_ms`.
fn local_clock(at_ms: i64, zone: &TimeZone) -> (usize, i64) {
    let zoned = Timestamp::from_millisecond(at_ms)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned(zone.clone());
    let day = usize::try_from(zoned.weekday().to_sunday_zero_offset()).unwrap_or(0);
    (
        day,
        i64::from(zoned.hour()) % 24 * 60 + i64::from(zoned.minute()),
    )
}

/// `windowOn(officeHours, day)`: that weekday's opening window.
fn window_on(office_hours: &Value, day: usize) -> Option<(i64, i64)> {
    let window = &office_hours["days"][WEEKDAYS[day % 7]];
    let start = minutes_of(window["start"].as_str()?)?;
    let end = minutes_of(window["end"].as_str()?)?;
    (end > start).then_some((start, end))
}

/// `new Date(ms).toISOString()`.
fn iso(ms: i64) -> Value {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .map_or(Value::Null, |at| json!(weldsuite_events::iso_timestamp(at)))
}

/// JavaScript truthiness of `officeHours?.enabled`.
fn enabled(office_hours: &Value) -> bool {
    match &office_hours["enabled"] {
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
        Value::Null => false,
    }
}

/// `officeHoursAvailability(officeHours, timeZone, now)`:
/// `{ isOpen, nextOpenAt }`. Off, the team counts as always in.
pub(crate) fn availability(office_hours: &Value, zone: Option<&str>, now_ms: i64) -> Value {
    if !enabled(office_hours) {
        return json!({ "isOpen": true, "nextOpenAt": null });
    }
    let zone = time_zone(zone);
    let now_minute = now_ms.div_euclid(MINUTE_MS) * MINUTE_MS;
    let (day, minutes) = local_clock(now_minute, &zone);

    if let Some((start, end)) = window_on(office_hours, day)
        && minutes >= start
        && minutes < end
    {
        return json!({ "isOpen": true, "nextOpenAt": null });
    }

    // Today's later window first, then the coming days, up to the same
    // weekday next week.
    for offset in 0..=7_i64 {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // 0..=7
        let Some((start, _)) = window_on(office_hours, (day + offset as usize) % 7) else {
            continue;
        };
        if offset == 0 && start <= minutes {
            continue;
        }
        let guess = now_minute + (offset * DAY_MINUTES + start - minutes) * MINUTE_MS;
        // A DST change in between shifts the wall clock by up to an hour:
        // correct once.
        let mut drift = start - local_clock(guess, &zone).1;
        if drift > DAY_MINUTES / 2 {
            drift -= DAY_MINUTES;
        }
        if drift < -DAY_MINUTES / 2 {
            drift += DAY_MINUTES;
        }
        return json!({ "isOpen": false, "nextOpenAt": iso(guess + drift * MINUTE_MS) });
    }
    json!({ "isOpen": false, "nextOpenAt": null })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-11-02 (a Monday) at `hh:mm` UTC, in ms.
    fn monday(hh: i64, mm: i64) -> i64 {
        1_793_577_600_000 + (hh * 60 + mm) * MINUTE_MS
    }

    fn weekdays_nine_to_five() -> Value {
        let window = json!({ "start": "09:00", "end": "17:00" });
        json!({ "enabled": true, "days": {
            "mon": window, "tue": window, "wed": window, "thu": window, "fri": window, "sat": null
        } })
    }

    #[test]
    fn off_is_always_open() {
        let off = json!({ "enabled": false, "days": {} });
        assert_eq!(
            availability(&off, None, monday(3, 0)),
            json!({ "isOpen": true, "nextOpenAt": null })
        );
        assert_eq!(availability(&Value::Null, None, 0)["isOpen"], true);
    }

    #[test]
    fn inside_a_window_is_open() {
        let hours = weekdays_nine_to_five();
        assert_eq!(
            availability(&hours, Some("UTC"), monday(9, 0))["isOpen"],
            true
        );
        assert_eq!(
            availability(&hours, Some("UTC"), monday(16, 59))["isOpen"],
            true
        );
    }

    #[test]
    fn closed_points_at_the_next_window() {
        let hours = weekdays_nine_to_five();
        assert_eq!(
            availability(&hours, Some("UTC"), monday(8, 30)),
            json!({ "isOpen": false, "nextOpenAt": "2026-11-02T09:00:00.000Z" })
        );
        assert_eq!(
            availability(&hours, Some("UTC"), monday(17, 0))["nextOpenAt"],
            "2026-11-03T09:00:00.000Z"
        );
        // Amsterdam is UTC+1 in November: 09:00 there is 08:00 UTC.
        assert_eq!(
            availability(&hours, Some("Europe/Amsterdam"), monday(7, 0))["nextOpenAt"],
            "2026-11-02T08:00:00.000Z"
        );
    }

    #[test]
    fn an_unknown_zone_is_utc_and_no_window_is_closed_for_good() {
        let hours = weekdays_nine_to_five();
        assert_eq!(
            availability(&hours, Some("Mars/Base"), monday(8, 0))["nextOpenAt"],
            "2026-11-02T09:00:00.000Z"
        );
        let none =
            json!({ "enabled": true, "days": { "mon": { "start": "10:00", "end": "09:00" } } });
        assert_eq!(
            availability(&none, None, monday(8, 0)),
            json!({ "isOpen": false, "nextOpenAt": null })
        );
    }

    #[test]
    fn times_parse_as_the_regex_does() {
        assert_eq!(minutes_of("24:00"), Some(1440));
        assert_eq!(minutes_of("09:30"), Some(570));
        assert_eq!(minutes_of("9:30"), None);
        assert_eq!(minutes_of("10:60"), None);
        assert_eq!(minutes_of("24:01"), None);
    }
}
