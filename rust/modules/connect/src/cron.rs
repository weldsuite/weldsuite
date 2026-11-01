//! `@weldsuite/workflow-integrations/cron`: five-field cron matching in a
//! time zone, the next fire time, and a naive local date-time read in a time
//! zone (`zonedTimeToUtc`). Times are epoch milliseconds.

// The matcher and the next-run computation serve the schedule sweep
// (`weldsuite cron workflow-schedules`, with the execution engine).
#![allow(dead_code)]

use jiff::Timestamp;
use jiff::tz::TimeZone;

const MINUTE_MS: i64 = 60_000;
const LOOKAHEAD_LIMIT_MINUTES: i64 = 366 * 24 * 60;

/// `new Intl.DateTimeFormat('en-US', { timeZone })` succeeds: an IANA name
/// (any case) or `UTC`.
pub(crate) fn time_zone(name: &str) -> Option<TimeZone> {
    let name = if name.is_empty() { "UTC" } else { name };
    TimeZone::get(name).ok()
}

/// `isValidTimezone(timezone)`.
pub(crate) fn is_valid_timezone(name: &str) -> bool {
    !name.is_empty() && TimeZone::get(name).is_ok()
}

struct Parts {
    minute: i64,
    hour: i64,
    day: i64,
    month: i64,
    weekday: i64,
}

fn parts(tz: &TimeZone, at_ms: i64) -> Option<Parts> {
    let zoned = Timestamp::from_millisecond(at_ms)
        .ok()?
        .to_zoned(tz.clone());
    Some(Parts {
        minute: i64::from(zoned.minute()),
        hour: i64::from(zoned.hour()) % 24,
        day: i64::from(zoned.day()),
        month: i64::from(zoned.month()),
        weekday: i64::from(zoned.weekday().to_sunday_zero_offset()),
    })
}

/// `Number.parseInt(text, 10)`: leading digits (after a sign), else `None`.
fn parse_int(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (sign, rest) = match text.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, text.strip_prefix('+').unwrap_or(text)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().map(|n| sign * n)
}

/// `Number(text)` for a range bound: digits only (with surrounding space).
fn number(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() {
        return Some(0.0);
    }
    text.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn match_field(field: &str, value: i64) -> bool {
    if field == "*" {
        return true;
    }
    if let Some(step) = field.strip_prefix("*/") {
        return parse_int(step).is_some_and(|step| step > 0 && value % step == 0);
    }
    for token in field.split(',') {
        if token.contains('-') {
            let mut bounds = token.split('-');
            let start = bounds.next().and_then(number);
            let end = bounds.next().and_then(number);
            #[allow(clippy::cast_precision_loss)]
            if let (Some(start), Some(end)) = (start, end)
                && (value as f64) >= start
                && (value as f64) <= end
            {
                return true;
            }
        } else if parse_int(token) == Some(value) {
            return true;
        }
    }
    false
}

fn matches(fields: &[&str], tz: &TimeZone, at_ms: i64) -> bool {
    let Some(p) = parts(tz, at_ms) else {
        return false;
    };
    match_field(fields[0], p.minute)
        && match_field(fields[1], p.hour)
        && match_field(fields[2], p.day)
        && match_field(fields[3], p.month)
        && match_field(fields[4], p.weekday)
}

/// `cronMatchesAt(expression, timezone, at)`.
pub(crate) fn cron_matches_at(expression: &str, timezone: &str, at_ms: i64) -> bool {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() < 5 {
        return false;
    }
    time_zone(timezone).is_some_and(|tz| matches(&fields, &tz, at_ms))
}

/// `computeNextRunAt(expression, timezone, from, { startDate, endDate })`:
/// the first whole minute strictly after `from` (and not before
/// `startDate`) the expression fires at, within a year and `endDate`.
pub(crate) fn compute_next_run_at(
    expression: &str,
    timezone: &str,
    from_ms: i64,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Option<i64> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() < 5 {
        return None;
    }
    let tz = time_zone(timezone)?;
    let base = from_ms.max(start_ms.unwrap_or(0));
    let mut candidate = base.div_euclid(MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    for _ in 0..LOOKAHEAD_LIMIT_MINUTES {
        if end_ms.is_some_and(|end| candidate > end) {
            return None;
        }
        if matches(&fields, &tz, candidate) {
            return Some(candidate);
        }
        candidate += MINUTE_MS;
    }
    None
}

/// `Date.UTC(y, month0, d, h, mi, s)`, overflowing fields carried over.
fn date_utc(year: i64, month0: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    let year = year + month0.div_euclid(12);
    let month = month0.rem_euclid(12) + 1;
    // Days from 1970-01-01 to the first of the month (Howard Hinnant's).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468 + (day - 1);
    ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000
}

/// `zonedTimeToUtc(localDateTime, timezone)`: `YYYY-MM-DDTHH:mm[:ss]`
/// (anything may follow) read as wall-clock time in `timezone`.
pub(crate) fn zoned_time_to_utc(local: &str, timezone: &str) -> Option<i64> {
    let text = local.trim();
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let slice = text.get(range)?;
        slice
            .bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| slice.parse().ok())
            .flatten()
    };
    if bytes.len() < 16
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
    {
        return None;
    }
    let (y, mo, d, h, mi) = (
        digits(0..4)?,
        digits(5..7)?,
        digits(8..10)?,
        digits(11..13)?,
        digits(14..16)?,
    );
    let s = if bytes.get(16) == Some(&b':') {
        digits(17..19).unwrap_or(0)
    } else {
        0
    };
    let naive = date_utc(y, mo - 1, d, h, mi, s);
    let tz = text_zone(timezone)?;
    let offset = tz
        .to_offset(Timestamp::from_millisecond(naive).ok()?)
        .seconds();
    Some(naive - i64::from(offset) * 1000)
}

/// The zone `(timezone || 'UTC').trim() || 'UTC'` names.
fn text_zone(timezone: &str) -> Option<TimeZone> {
    let name = timezone.trim();
    time_zone(if name.is_empty() { "UTC" } else { name })
}

/// Epoch milliseconds as `toISOString()`.
pub(crate) fn iso(ms: i64) -> Option<String> {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).ok()?;
    Some(weldsuite_events::iso_timestamp(at))
}

/// An ISO timestamp (`toISOString()` or a Postgres one) as epoch ms.
pub(crate) fn parse_ms(text: &str) -> Option<i64> {
    let iso = weldsuite_db::js_timestamp(text)?;
    let at =
        time::OffsetDateTime::parse(&iso, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn reads_wall_clock_time_in_a_zone() {
        // 2026-07-01 09:00 in Amsterdam (CEST, +02:00) is 07:00Z.
        let at = zoned_time_to_utc("2026-07-01T09:00", "Europe/Amsterdam").unwrap();
        assert_eq!(iso(at).unwrap(), "2026-07-01T07:00:00.000Z");
        assert_eq!(zoned_time_to_utc("nope", "UTC"), None);
        assert_eq!(zoned_time_to_utc("2026-07-01T09:00", "Mars/Base"), None);
    }

    #[test]
    fn finds_the_next_fire_time() {
        let from = parse_ms("2026-07-01T08:59:30.000Z").unwrap();
        let next = compute_next_run_at("0 9 * * *", "UTC", from, None, None).unwrap();
        assert_eq!(iso(next).unwrap(), "2026-07-01T09:00:00.000Z");
        assert!(cron_matches_at(
            "*/15 * * * *",
            "UTC",
            parse_ms("2026-07-01T09:45:00.000Z").unwrap()
        ));
        assert!(!cron_matches_at(
            "1-5 * * * *",
            "UTC",
            parse_ms("2026-07-01T09:45:00.000Z").unwrap()
        ));
    }
}
