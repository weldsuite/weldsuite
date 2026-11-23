//! JavaScript `Date` arithmetic in UTC, on time values (milliseconds as
//! `f64`, NaN for an Invalid Date), as the scheduler uses it.

use time::{OffsetDateTime, PrimitiveDateTime};

pub(crate) const DAY_MS: f64 = 86_400_000.0;
const MAX_TIME: f64 = 8.64e15;

fn day_of(t: f64) -> f64 {
    (t / DAY_MS).floor()
}

fn clip(t: f64) -> f64 {
    if t.is_finite() && t.abs() <= MAX_TIME {
        t
    } else {
        f64::NAN
    }
}

/// `date.setHours(hours, minutes, 0, 0)`: fractions dropped, overflow carried.
pub(crate) fn set_hours(day: f64, hours: f64, minutes: f64) -> f64 {
    if !day.is_finite() || !hours.is_finite() || !minutes.is_finite() {
        return f64::NAN;
    }
    clip(day_of(day) * DAY_MS + hours.trunc() * 3_600_000.0 + minutes.trunc() * 60_000.0)
}

/// `date.setHours(0, 0, 0, 0)`.
pub(crate) fn start_of_day(t: f64) -> f64 {
    if t.is_finite() {
        day_of(t) * DAY_MS
    } else {
        f64::NAN
    }
}

/// `date.setHours(23, 59, 59, 999)`.
pub(crate) fn end_of_day(t: f64) -> f64 {
    if t.is_finite() {
        day_of(t) * DAY_MS + DAY_MS - 1.0
    } else {
        f64::NAN
    }
}

/// `date.getDay()` (0 = Sunday); `None` for an Invalid Date.
pub(crate) fn weekday(t: f64) -> Option<usize> {
    if !t.is_finite() {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some((day_of(t) + 4.0).rem_euclid(7.0) as usize)
}

/// `a.toDateString() === b.toDateString()` (two Invalid Dates are equal).
pub(crate) fn same_day(a: f64, b: f64) -> bool {
    match (a.is_finite(), b.is_finite()) {
        // Both are whole day numbers.
        (true, true) => (day_of(a) - day_of(b)).abs() < 0.5,
        (false, false) => true,
        _ => false,
    }
}

/// A `timestamp` column as a time value (UTC, as Drizzle reads it; the
/// microseconds dropped, as `Date` does).
pub(crate) fn from_db(at: PrimitiveDateTime) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    {
        at.assume_utc().unix_timestamp_nanos().div_euclid(1_000_000) as f64
    }
}

/// A `timestamp` column as `Date#toISOString()` writes it.
pub(crate) fn iso_of(at: PrimitiveDateTime) -> String {
    weldsuite_events::iso_timestamp(at.assume_utc())
}

/// `new Date(ms)` (the epoch when out of range).
pub(crate) fn instant(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// `Number(text)`.
pub(crate) fn js_number(text: &str) -> f64 {
    weldsuite_kit::validation::js_number(text)
}

/// `new Date(ms).toISOString()`.
pub fn iso(ms: i64) -> String {
    weldsuite_events::iso_timestamp(instant(ms))
}

/// `Date.now()`.
pub fn now_ms() -> f64 {
    #[allow(clippy::cast_precision_loss)]
    {
        (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_are_utc_days() {
        let thursday = 0.0; // 1970-01-01
        assert_eq!(weekday(thursday), Some(4));
        assert_eq!(weekday(f64::NAN), None);
        assert_eq!(
            set_hours(DAY_MS + 5.0, 9.0, 30.0),
            DAY_MS + 9.5 * 3_600_000.0
        );
        assert!(set_hours(0.0, f64::NAN, 0.0).is_nan());
        assert!(same_day(10.0, DAY_MS - 1.0));
        assert!(!same_day(10.0, DAY_MS));
        assert_eq!(end_of_day(10.0), DAY_MS - 1.0);
        let at = PrimitiveDateTime::new(
            time::Date::from_calendar_date(2030, time::Month::March, 1).expect("date"),
            time::Time::from_hms_micro(10, 0, 0, 123_456).expect("time"),
        );
        assert_eq!(from_db(at), 1_898_589_600_123.0);
        assert_eq!(iso_of(at), "2030-03-01T10:00:00.123Z");
    }
}
