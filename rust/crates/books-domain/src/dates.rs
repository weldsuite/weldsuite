//! Calendar dates as `YYYY-MM-DD` strings
//! (`@weldsuite/books-domain/us-compliance/dates`): arithmetic in UTC, so a
//! time zone never moves a due date.

use crate::js::{civil_from_days, days_from_civil};

/// `{ y, m, d }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateParts {
    pub y: i64,
    pub m: i64,
    pub d: i64,
}

fn split(value: &str) -> Option<(i64, i64, i64)> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| {
        let part = &value[range];
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse::<i64>().ok())
            .flatten()
    };
    Some((digits(0..4)?, digits(5..7)?, digits(8..10)?))
}

/// `isIsoDate(value)`.
pub fn is_iso_date(value: &str) -> bool {
    match split(value) {
        Some((y, m, d)) => (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m),
        None => false,
    }
}

/// `parseIso(value)`; `None` where TypeScript throws `Invalid date`.
pub fn parse_iso(value: &str) -> Option<DateParts> {
    if !is_iso_date(value) {
        return None;
    }
    let (y, m, d) = split(value)?;
    Some(DateParts { y, m, d })
}

/// `formatIso(y, m, d)`.
pub fn format_iso(y: i64, m: i64, d: i64) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

/// `daysInMonth(y, m)`.
pub fn days_in_month(y: i64, m: i64) -> i64 {
    // `new Date(Date.UTC(y, m, 0)).getUTCDate()`: day 0 of the next month.
    let index = y * 12 + m; // the next month, 0-based
    let next_year = index.div_euclid(12);
    let next_month = index.rem_euclid(12) + 1;
    let (_, _, d) = civil_from_days(days_from_civil(next_year, next_month, 1) - 1);
    d
}

/// `Date.UTC(y, m - 1, d)` as days since the epoch (any day, month overflow
/// rolls over as JavaScript's does).
fn utc_days(y: i64, m: i64, d: i64) -> i64 {
    let index = y * 12 + (m - 1);
    days_from_civil(index.div_euclid(12), index.rem_euclid(12) + 1, 1) + d - 1
}

fn from_days(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format_iso(y, m, d)
}

/// `addDays(value, days)`.
pub fn add_days(value: &str, days: i64) -> Option<String> {
    let p = parse_iso(value)?;
    Some(from_days(utc_days(p.y, p.m, p.d + days)))
}

/// `addMonths(value, months)`: the day clamped to the end of a shorter month.
pub fn add_months(value: &str, months: i64) -> Option<String> {
    let p = parse_iso(value)?;
    let index = p.y * 12 + (p.m - 1) + months;
    let year = index.div_euclid(12);
    let month = index.rem_euclid(12) + 1;
    Some(format_iso(year, month, p.d.min(days_in_month(year, month))))
}

/// `diffDays(a, b)`: whole days from `a` to `b`.
pub fn diff_days(a: &str, b: &str) -> Option<i64> {
    let pa = parse_iso(a)?;
    let pb = parse_iso(b)?;
    Some(utc_days(pb.y, pb.m, pb.d) - utc_days(pa.y, pa.m, pa.d))
}

/// `weekdayOf(value)`: 0 = Sunday … 6 = Saturday.
pub fn weekday_of(value: &str) -> Option<i64> {
    let p = parse_iso(value)?;
    // 1970-01-01 was a Thursday (4).
    Some((utc_days(p.y, p.m, p.d) + 4).rem_euclid(7))
}

/// `lastDayOfMonth(y, m)`.
pub fn last_day_of_month(y: i64, m: i64) -> String {
    format_iso(y, m, days_in_month(y, m))
}

/// `endOfMonth(value)`.
pub fn end_of_month(value: &str) -> Option<String> {
    let p = parse_iso(value)?;
    Some(last_day_of_month(p.y, p.m))
}

/// `startOfMonth(value)`.
pub fn start_of_month(value: &str) -> Option<String> {
    let p = parse_iso(value)?;
    Some(format_iso(p.y, p.m, 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_arithmetic_matches_javascript() {
        assert_eq!(add_days("2026-02-27", 2).as_deref(), Some("2026-03-01"));
        assert_eq!(add_months("2026-01-31", 1).as_deref(), Some("2026-02-28"));
        assert_eq!(add_months("2026-01-15", -13).as_deref(), Some("2024-12-15"));
        assert_eq!(diff_days("2026-01-01", "2026-12-31"), Some(364));
        assert_eq!(weekday_of("2026-10-31"), Some(6));
        assert_eq!(days_in_month(2024, 2), 29);
        assert!(!is_iso_date("2026-02-30"));
    }
}
