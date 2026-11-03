//! JavaScript date semantics the calendar routes depend on, shared by
//! WeldCalendar (`modules/calendar`) and personal WeldCalendar
//! (`modules/personal`): `new Date(text)`, IANA zones as `Intl` reads them,
//! and the booking-page slot helpers of `services/calendar-slots.ts`
//! (`fromZonedTime`, `weekdayNameForDate`), which calendar-api and
//! personal-api each carry a copy of.

/// One day in milliseconds.
pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// The largest time value a JavaScript `Date` holds (±8.64e15 ms).
const MAX_TIME: i64 = 8_640_000_000_000_000;

/// `new Date(text).getTime()`, `None` for an Invalid Date. The ISO formats
/// (`2030-03-01`, `2030-03-01T10:00:00.000Z`, `…+01:00`), V8's tolerance of
/// a space for the `T`, one-digit months and days and `/` separators. A
/// time without an offset is local time, which is UTC in the Workers
/// runtime. V8's other legacy formats (`March 1, 2030`) are not read.
pub fn parse_date(text: &str) -> Option<i64> {
    let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let (date, rest) = split_date(text)?;
    let (year, month, day) = date;
    let mut millis_of_day = 0i64;
    let mut offset_minutes = 0i64;
    if !rest.is_empty() {
        let rest = rest
            .strip_prefix(['T', 't', ' '])
            .filter(|rest| !rest.is_empty())?;
        let (time, offset) = split_offset(rest);
        millis_of_day = parse_time(time)?;
        offset_minutes = parse_offset(offset)?;
    }
    let days = days_from_civil(year, month, 1) + i64::from(day) - 1;
    let value = days * DAY_MS + millis_of_day - offset_minutes * 60_000;
    (value.abs() <= MAX_TIME).then_some(value)
}

/// `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (or `±YYYYYY…`, `/` separators, one-digit
/// month and day) and what follows it.
fn split_date(text: &str) -> Option<((i64, u32, u32), &str)> {
    let bytes = text.as_bytes();
    let (sign, start, year_len) = match bytes.first()? {
        b'+' => (1, 1, 6),
        b'-' => (-1, 1, 6),
        _ => (1, 0, 4),
    };
    let year_text = text.get(start..start + year_len)?;
    if !year_text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let year = sign * year_text.parse::<i64>().ok()?;
    let mut rest = &text[start + year_len..];
    let mut month = 1;
    let mut day = 1;
    if let Some(separator) = rest.chars().next().filter(|c| matches!(c, '-' | '/')) {
        let (value, after) = leading_number(&rest[1..], 2)?;
        month = value;
        rest = after;
        if let Some(after) = rest.strip_prefix(separator) {
            let (value, after) = leading_number(after, 2)?;
            day = value;
            rest = after;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(((year, month, day), rest))
}

/// One or two leading digits (at most `max`) as a number, and the rest.
fn leading_number(text: &str, max: usize) -> Option<(u32, &str)> {
    let digits = text
        .bytes()
        .take(max)
        .take_while(u8::is_ascii_digit)
        .count();
    if digits == 0 {
        return None;
    }
    Some((text[..digits].parse().ok()?, &text[digits..]))
}

/// `10:00:00.000` and `Z` / `+01:00` / `+0100` / nothing.
fn split_offset(text: &str) -> (&str, &str) {
    match text.find(['Z', 'z', '+', '-']) {
        Some(at) => (&text[..at], &text[at..]),
        None => (text, ""),
    }
}

/// `HH:mm[:ss[.fff…]]` in milliseconds; `24:00` is the end of the day.
fn parse_time(text: &str) -> Option<i64> {
    let mut parts = text.splitn(3, ':');
    let hours = two_digits(parts.next()?)?;
    let minutes = two_digits(parts.next()?)?;
    let (seconds, millis) = match parts.next() {
        None => (0, 0),
        Some(rest) => {
            let (whole, fraction) = rest.split_once('.').unwrap_or((rest, ""));
            let seconds = two_digits(whole)?;
            if rest.contains('.')
                && (fraction.is_empty() || !fraction.bytes().all(|b| b.is_ascii_digit()))
            {
                return None;
            }
            let millis: String = fraction.chars().chain("000".chars()).take(3).collect();
            (seconds, millis.parse::<i64>().ok()?)
        }
    };
    if hours > 24 || minutes > 59 || seconds > 59 {
        return None;
    }
    if hours == 24 && (minutes != 0 || seconds != 0 || millis != 0) {
        return None;
    }
    Some(((hours * 60 + minutes) * 60 + seconds) * 1000 + millis)
}

fn two_digits(text: &str) -> Option<i64> {
    (text.len() == 2 && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// `Z`, `+01:00`, `+0100` or nothing, in minutes east of UTC.
fn parse_offset(text: &str) -> Option<i64> {
    if text.is_empty() || text.eq_ignore_ascii_case("z") {
        return Some(0);
    }
    let sign = match text.as_bytes()[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let rest = &text[1..];
    let (hours, minutes) = match rest.split_once(':') {
        Some((h, m)) => (h, m),
        None if rest.len() == 4 => rest.split_at(2),
        None => return None,
    };
    let hours = two_digits(hours)?;
    let minutes = two_digits(minutes)?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some(sign * (hours * 60 + minutes))
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let (y, m, d) = (
        year - i64::from(month <= 2),
        i64::from(month),
        i64::from(day),
    );
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The zone `Intl` would format in: an IANA name (case-insensitive), or an
/// offset (`+01:00`, `+0100`, `+01`).
pub fn time_zone(zone: &str) -> Option<jiff::tz::TimeZone> {
    if let Some(offset) = offset_zone(zone) {
        return jiff::tz::Offset::from_seconds(offset * 60)
            .ok()
            .map(jiff::tz::TimeZone::fixed);
    }
    jiff::tz::db().get(zone).ok()
}

/// `±HH[:MM]` / `±HHMM` in minutes.
fn offset_zone(zone: &str) -> Option<i32> {
    let sign = match zone.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let rest = &zone[1..];
    let (hours, minutes) = match rest.len() {
        2 => (rest, "00"),
        4 => rest.split_at(2),
        5 if rest.as_bytes()[2] == b':' => (&rest[..2], &rest[3..]),
        _ => return None,
    };
    let hours: i32 = i32::try_from(two_digits(hours)?).ok()?;
    let minutes: i32 = i32::try_from(two_digits(minutes)?).ok()?;
    (hours <= 23 && minutes <= 59).then_some(sign * (hours * 60 + minutes))
}

const DAY_NAMES: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

/// The zone's offset at an instant, in milliseconds (`zoneOffsetMs`).
pub fn zone_offset_ms(instant: i64, zone: &jiff::tz::TimeZone) -> Result<i64, String> {
    let at = jiff::Timestamp::from_millisecond(instant).map_err(|error| error.to_string())?;
    Ok(i64::from(zone.to_offset(at).seconds()) * 1000)
}

/// A wall-clock time in `zone` as an instant (`fromZonedTime`): the offset
/// read twice so a DST change resolves to the right side.
pub fn from_zoned_time(wall_clock: &str, zone: &jiff::tz::TimeZone) -> Result<i64, String> {
    let naive = parse_date(&format!("{wall_clock}Z"))
        .ok_or_else(|| format!("Invalid wall-clock timestamp: {wall_clock}"))?;
    let first = naive - zone_offset_ms(naive, zone)?;
    Ok(naive - zone_offset_ms(first, zone)?)
}

/// The weekday of a calendar date (`weekdayNameForDate`).
pub fn weekday_name(date: &str) -> Result<&'static str, String> {
    let at =
        parse_date(&format!("{date}T00:00:00Z")).ok_or_else(|| format!("Invalid date: {date}"))?;
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let day = (at.div_euclid(DAY_MS) + 4).rem_euclid(7) as usize;
    Ok(DAY_NAMES[day])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_clock_times_resolve_in_the_zone() {
        let amsterdam = time_zone("Europe/Amsterdam").expect("zone");
        // Winter (UTC+1) and summer (UTC+2) time.
        assert_eq!(
            from_zoned_time("2030-03-04T09:00:00", &amsterdam).map(crate::iso),
            Ok("2030-03-04T08:00:00.000Z".to_owned())
        );
        assert_eq!(
            from_zoned_time("2030-04-01T09:00:00", &amsterdam).map(crate::iso),
            Ok("2030-04-01T07:00:00.000Z".to_owned())
        );
        assert!(from_zoned_time("someday", &amsterdam).is_err());
        assert_eq!(weekday_name("2030-03-04"), Ok("monday"));
        assert!(weekday_name("someday").is_err());
        assert!(time_zone("Mars/Base").is_none());
        assert!(time_zone("+01:00").is_some());
        assert_eq!(parse_date("2030-03-01"), Some(1_898_553_600_000));
    }
}
