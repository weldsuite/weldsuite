//! Calendar-date helpers for tax points (`sales-tax/dates.ts`): dates are
//! `YYYY-MM-DD` strings compared as text; arithmetic goes through UTC so a
//! time zone never moves a tax point. Unlike `us-compliance/dates`, a date
//! only needs to *start* with `YYYY-MM-DD` (`/^(\d{4})-(\d{2})-(\d{2})/`), and
//! an out-of-range day rolls over as `Date.UTC` does.

use crate::js::{civil_from_days, days_from_civil};
use crate::jurisdictions::js_trim;

/// `isoDay(value)`: the `YYYY-MM-DD` part (the first ten characters,
/// trimmed).
pub fn iso_day(value: &str) -> String {
    js_trim(value).chars().take(10).collect()
}

fn parts(value: &str) -> Option<(i64, i64, i64)> {
    let text = js_trim(value).as_bytes();
    if text.len() < 10 || text[4] != b'-' || text[7] != b'-' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let digits = &text[range];
        digits
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| std::str::from_utf8(digits).ok()?.parse().ok())
            .flatten()
    };
    Some((number(0..4)?, number(5..7)?, number(8..10)?))
}

/// `isIsoDay(value)`: starts with `YYYY-MM-DD`.
pub fn is_iso_day(value: Option<&str>) -> bool {
    value.is_some_and(|v| !v.is_empty() && parts_raw(v).is_some())
}

/// `ISO_DAY.test(value)` on the value as is (not trimmed).
fn parts_raw(value: &str) -> Option<()> {
    let text = value.as_bytes();
    (text.len() >= 10
        && text[4] == b'-'
        && text[7] == b'-'
        && text[..4].iter().all(u8::is_ascii_digit)
        && text[5..7].iter().all(u8::is_ascii_digit)
        && text[8..10].iter().all(u8::is_ascii_digit))
    .then_some(())
}

fn format(y: i64, m: i64, d: i64) -> String {
    if y < 0 {
        // `String(y).padStart(4, '0')` of a negative year.
        format!("{:0>4}-{m:02}-{d:02}", y.to_string())
    } else {
        format!("{y:04}-{m:02}-{d:02}")
    }
}

fn utc(y: i64, m0: i64, d: i64) -> i64 {
    let index = y * 12 + m0;
    days_from_civil(index.div_euclid(12), index.rem_euclid(12) + 1, 1) + d - 1
}

fn day_text(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn days_in_month(y: i64, m: i64) -> i64 {
    // `new Date(Date.UTC(y, m, 0)).getUTCDate()`.
    let (_, _, d) = civil_from_days(utc(y, m, 0));
    d
}

/// `addDays(value, days)`; `None` where TypeScript throws `Invalid date`.
pub fn add_days(value: &str, days: i64) -> Option<String> {
    let (y, m, d) = parts(value)?;
    Some(day_text(utc(y, m - 1, d + days)))
}

/// `addMonths(value, months)`: the day clamped to the end of a shorter month.
pub fn add_months(value: &str, months: i64) -> Option<String> {
    let (y, m, d) = parts(value)?;
    let index = y * 12 + (m - 1) + months;
    let year = index.div_euclid(12);
    let month = index.rem_euclid(12) + 1;
    Some(format(year, month, d.min(days_in_month(year, month))))
}

/// `endOfYear(value)`: 31 December of the date's year.
pub fn end_of_year(value: &str) -> Option<String> {
    let (y, _, _) = parts(value)?;
    Some(format(y, 12, 31))
}

/// `inRange(date, from, to)`: `from <= date` and (`to` empty or
/// `date <= to`); an empty `from` is no lower bound.
pub fn in_range(date: &str, from: Option<&str>, to: Option<&str>) -> bool {
    let day = iso_day(date);
    if let Some(from) = from.filter(|f| !f.is_empty())
        && day < iso_day(from)
    {
        return false;
    }
    if let Some(to) = to.filter(|t| !t.is_empty())
        && day > iso_day(to)
    {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tax_point_arithmetic() {
        assert_eq!(add_days("2026-07-05", 90).as_deref(), Some("2026-10-03"));
        assert_eq!(add_days("2026-02-30", 0).as_deref(), Some("2026-03-02"));
        assert_eq!(add_months("2025-01-31", 1).as_deref(), Some("2025-02-28"));
        assert_eq!(add_months("2025-03-15", 48).as_deref(), Some("2029-03-15"));
        assert_eq!(
            end_of_year("2026-04-01T00:00").as_deref(),
            Some("2026-12-31")
        );
        assert!(in_range("2026-05-01", Some("2026-01-01"), None));
        assert!(!in_range(
            "2026-05-01",
            Some("2026-01-01"),
            Some("2026-04-30")
        ));
        assert!(in_range("2026-05-01", None, Some("")));
        assert!(is_iso_day(Some("2026-01-01T10:00:00Z")));
        assert!(!is_iso_day(Some(" 2026-01-01")));
        assert!(!is_iso_day(None));
    }
}
