//! Milliseconds since the epoch, as JavaScript's `Date` counts them, and the
//! few `Date` methods the guard uses.

use std::time::{SystemTime, UNIX_EPOCH};

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// `Date.now()`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

fn at(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// `new Date(ms).toISOString()`: `2026-10-13T10:00:00.000Z`.
pub fn iso(ms: i64) -> String {
    let t = at(ms);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

/// `Date.parse(text)` for ISO times; `None` for anything else.
pub fn parse_iso(text: &str) -> Option<i64> {
    let parsed = OffsetDateTime::parse(text, &Rfc3339).ok()?;
    i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok()
}

/// `YYYYMM` of the UTC month (`monthKey`).
pub fn month_key(ms: i64) -> String {
    let t = at(ms);
    format!("{:04}{:02}", t.year(), u8::from(t.month()))
}

/// The first millisecond of the next UTC month (`nextMonthStart`).
pub fn next_month_start(ms: i64) -> i64 {
    let t = at(ms);
    let (year, month) = if u8::from(t.month()) == 12 {
        (t.year() + 1, 1)
    } else {
        (t.year(), u8::from(t.month()) + 1)
    };
    let month = time::Month::try_from(month).unwrap_or(time::Month::January);
    time::Date::from_calendar_date(year, month, 1).map_or(0, |date| {
        let start = date.midnight().assume_utc();
        i64::try_from(start.unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
    })
}

/// `new Date(ms).toISOString().slice(0, 10)`: the UTC day, `2026-10-13`.
pub fn day_stamp(ms: i64) -> String {
    iso(ms)[..10].to_owned()
}

/// A clock the ledger reads; tests pin it.
pub type Clock = std::sync::Arc<dyn Fn() -> i64 + Send + Sync>;

/// The system clock.
pub fn system_clock() -> Clock {
    std::sync::Arc::new(now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_javascript() {
        let ms = 1_791_883_800_000; // 2026-10-13T09:30:00.000Z
        assert_eq!(iso(ms), "2026-10-13T09:30:00.000Z");
        assert_eq!(parse_iso("2026-10-13T09:30:00.000Z"), Some(ms));
        assert_eq!(month_key(ms), "202610");
        assert_eq!(iso(next_month_start(ms)), "2026-11-01T00:00:00.000Z");
        assert_eq!(
            iso(next_month_start(
                parse_iso("2026-12-31T23:00:00Z").expect("iso")
            )),
            "2027-01-01T00:00:00.000Z"
        );
        assert_eq!(day_stamp(ms), "2026-10-13");
    }
}
