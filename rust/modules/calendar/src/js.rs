//! JavaScript semantics the routes depend on: `new Date(text)`,
//! `Date#toISOString()`, `JSON.stringify` key order and number printing,
//! and IANA zone checks as `Intl.DateTimeFormat` makes them.

use serde_json::Value;
use time::OffsetDateTime;

/// One day in milliseconds.
pub(crate) const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// The largest time value a JavaScript `Date` holds (±8.64e15 ms).
const MAX_TIME: i64 = 8_640_000_000_000_000;

/// `new Date(text).getTime()`, `None` for an Invalid Date. The ISO formats
/// (`2030-03-01`, `2030-03-01T10:00:00.000Z`, `…+01:00`), V8's tolerance of
/// a space for the `T`, one-digit months and days and `/` separators. A
/// time without an offset is local time, which is UTC in the Workers
/// runtime. V8's other legacy formats (`March 1, 2030`) are not read.
pub(crate) fn parse_date(text: &str) -> Option<i64> {
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

/// `new Date(millis).toISOString()`.
pub(crate) fn iso(millis: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    weldsuite_events::iso_timestamp(at)
}

/// Milliseconds of an ISO timestamp the database handed back (`toISOString`
/// form, as `js_row` writes it).
pub(crate) fn millis_of(value: &Value) -> Option<i64> {
    value.as_str().and_then(parse_date)
}

/// Now, in milliseconds (`Date.now()`).
pub(crate) fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}

/// Whether `Intl.DateTimeFormat` accepts `zone` (`isValidTimeZone`): an IANA
/// name (case-insensitive) or `UTC`, at most 50 characters.
pub(crate) fn is_valid_time_zone(zone: &str) -> bool {
    if zone.is_empty() || zone.encode_utf16().count() > 50 {
        return false;
    }
    time_zone(zone).is_some()
}

/// The zone `Intl` would format in: an IANA name (case-insensitive), or an
/// offset (`+01:00`, `+0100`, `+01`).
pub(crate) fn time_zone(zone: &str) -> Option<jiff::tz::TimeZone> {
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

/// `validTimeZoneOrUndefined`.
pub(crate) fn valid_zone(zone: Option<&str>) -> Option<String> {
    zone.filter(|zone| is_valid_time_zone(zone))
        .map(str::to_owned)
}

/// A number as `JSON.stringify` and `String()` print it: integral values
/// without a fraction.
pub(crate) fn js_number(value: &serde_json::Number) -> Value {
    if value.is_i64() || value.is_u64() {
        return Value::Number(value.clone());
    }
    let float = value.as_f64().unwrap_or(f64::NAN);
    #[allow(clippy::cast_possible_truncation)]
    if float.is_finite() && float.fract() == 0.0 && float.abs() < 9.0e15 {
        return Value::from(float as i64);
    }
    Value::Number(value.clone())
}

/// A JSON value with its numbers as JavaScript writes them (for `jsonb`).
pub(crate) fn js_value(value: &Value) -> Value {
    match value {
        Value::Number(number) => js_number(number),
        Value::Array(items) => Value::Array(items.iter().map(js_value).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), js_value(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `String(value)` for what a JSON body holds.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number(number).to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// An object in JavaScript's key order (insertion order), for
/// `JSON.stringify`.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Ordered(pub(crate) Vec<(String, OrderedValue)>);

/// A JSON value whose objects keep their key order.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OrderedValue {
    Plain(Value),
    Object(Ordered),
    Array(Vec<OrderedValue>),
}

impl Ordered {
    pub(crate) fn push(&mut self, key: &str, value: OrderedValue) {
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value;
        } else {
            self.0.push((key.to_owned(), value));
        }
    }

    pub(crate) fn plain(&mut self, key: &str, value: Value) {
        self.push(key, OrderedValue::Plain(value));
    }

    pub(crate) fn get(&self, key: &str) -> Option<&OrderedValue> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// The same object as a `serde_json` value (keys sorted; for responses,
    /// events and the database, where order does not matter).
    pub(crate) fn to_value(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .map(|(key, value)| (key.clone(), value.to_value()))
                .collect(),
        )
    }

    /// `JSON.stringify(object)`.
    pub(crate) fn stringify(&self) -> String {
        let mut out = String::from("{");
        for (index, (key, value)) in self.0.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&Value::String(key.clone()).to_string());
            out.push(':');
            out.push_str(&value.stringify());
        }
        out.push('}');
        out
    }
}

impl OrderedValue {
    pub(crate) fn to_value(&self) -> Value {
        match self {
            Self::Plain(value) => value.clone(),
            Self::Object(object) => object.to_value(),
            Self::Array(items) => Value::Array(items.iter().map(Self::to_value).collect()),
        }
    }

    fn stringify(&self) -> String {
        match self {
            Self::Plain(value) => js_value(value).to_string(),
            Self::Object(object) => object.stringify(),
            Self::Array(items) => format!(
                "[{}]",
                items
                    .iter()
                    .map(Self::stringify)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(text: &str) -> Option<String> {
        parse_date(text).map(iso)
    }

    #[test]
    fn dates_parse_like_v8_in_utc() {
        assert_eq!(d("2030-02-30").as_deref(), Some("2030-03-02T00:00:00.000Z"));
        assert_eq!(
            d("2030-02-28T24:00").as_deref(),
            Some("2030-03-01T00:00:00.000Z")
        );
        assert_eq!(d("2030-02-28T24:00:01"), None);
        assert_eq!(
            d("2030-03-01 10:00").as_deref(),
            Some("2030-03-01T10:00:00.000Z")
        );
        assert_eq!(d("2030-03-01T10"), None);
        assert_eq!(
            d("2030-03-01t10:00z").as_deref(),
            Some("2030-03-01T10:00:00.000Z")
        );
        assert_eq!(d("2030-3-1").as_deref(), Some("2030-03-01T00:00:00.000Z"));
        assert_eq!(d("2030/03/01").as_deref(), Some("2030-03-01T00:00:00.000Z"));
        assert_eq!(d("2030").as_deref(), Some("2030-01-01T00:00:00.000Z"));
        assert_eq!(d("2030-03").as_deref(), Some("2030-03-01T00:00:00.000Z"));
        assert_eq!(
            d("+002030-03-01").as_deref(),
            Some("2030-03-01T00:00:00.000Z")
        );
        assert_eq!(
            d("2030-03-01T10:00:00.123456Z").as_deref(),
            Some("2030-03-01T10:00:00.123Z")
        );
        assert_eq!(
            d("2030-03-01T10:00:00+0100").as_deref(),
            Some("2030-03-01T09:00:00.000Z")
        );
        assert_eq!(d("2030-03-01T10:00:00+01"), None);
        assert_eq!(
            d("  2030-03-01").as_deref(),
            Some("2030-03-01T00:00:00.000Z")
        );
        assert_eq!(d("not-a-date"), None);
        assert_eq!(d("2030-13-01"), None);
        assert_eq!(d("2030-03-01T10:00:60"), None);
        assert_eq!(d("2030-03-01T25:00"), None);
        assert_eq!(d("2030-03-01T10:00:00.Z"), None);
        assert_eq!(
            d("2030-03-01T10:00Z").as_deref(),
            Some("2030-03-01T10:00:00.000Z")
        );
        assert_eq!(
            d("1969-12-31T23:59:59.999Z").as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
    }

    #[test]
    fn zones_are_checked_like_intl() {
        assert!(is_valid_time_zone("Europe/Amsterdam"));
        assert!(is_valid_time_zone("UTC"));
        assert!(!is_valid_time_zone("Mars/Olympus"));
        assert!(!is_valid_time_zone("nope"));
        assert!(!is_valid_time_zone(""));
    }

    #[test]
    fn objects_stringify_in_insertion_order() {
        let mut object = Ordered::default();
        object.plain("id", Value::from("evt_1"));
        object.plain("title", Value::from("A"));
        object.plain("minutes", serde_json::json!(15.0));
        assert_eq!(
            object.stringify(),
            r#"{"id":"evt_1","title":"A","minutes":15}"#
        );
    }
}
