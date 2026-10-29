//! What the TypeScript worker gets from JavaScript itself and the ported
//! code has to reproduce: its whitespace, `String#trim`, UTF-16 lengths and
//! slices, `Number.parseInt`, `new Date(text)` for ISO strings, and object
//! keys that `Object.prototype` already answers for.

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// A character JavaScript's `\s` and `String#trim` treat as whitespace: the
/// Unicode `White_Space` set without U+0085, plus the BOM.
pub(crate) fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `text.trim()`.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `text.length`: UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(start, end)` in UTF-16 code units (non-negative bounds,
/// clamped). A surrogate pair cut in half becomes U+FFFD, as it does when
/// the string is written out as UTF-8.
pub(crate) fn utf16_slice(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = end.min(units.len());
    let start = start.min(end);
    String::from_utf16_lossy(&units[start..end])
}

/// `text.slice(-count)`: the last `count` UTF-16 code units.
pub(crate) fn utf16_tail(text: &str, count: usize) -> String {
    let length = utf16_len(text);
    utf16_slice(text, length.saturating_sub(count), length)
}

/// `Number.parseInt(text, radix)` for radix 10 or 16: leading whitespace, a
/// sign, (radix 16) an optional `0x`, then the longest run of digits. `None`
/// is `NaN`.
pub(crate) fn parse_int(text: &str, radix: u32) -> Option<f64> {
    let rest = text.trim_start_matches(is_js_space);
    let (negative, rest) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let rest = if radix == 16 {
        rest.strip_prefix("0x")
            .or_else(|| rest.strip_prefix("0X"))
            .unwrap_or(rest)
    } else {
        rest
    };
    let digits: &str = &rest[..rest
        .char_indices()
        .find(|(_, c)| !c.is_digit(radix))
        .map_or(rest.len(), |(index, _)| index)];
    if digits.is_empty() {
        return None;
    }
    let mut value = 0.0_f64;
    for c in digits.chars() {
        value = value * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0));
    }
    Some(if negative { -value } else { value })
}

/// `Number.parseInt(text ?? fallback, 10)` clamped to `[min, max]`, or
/// `fallback` when it is not a number: the `limit` query parameter of the
/// list routes.
pub(crate) fn clamped_limit(text: Option<&str>, fallback: i64, min: i64, max: i64) -> i64 {
    let fallback_text = fallback.to_string();
    match parse_int(text.unwrap_or(&fallback_text), 10) {
        // Finite and clamped, so the cast cannot truncate.
        #[allow(clippy::cast_possible_truncation)]
        Some(value) if value.is_finite() => (value.clamp(min as f64, max as f64)) as i64,
        _ => fallback,
    }
}

/// `new Date(text)` for the cursors the list routes take, as `toISOString()`
/// prints the result (milliseconds, `Z`); `None` for an invalid date.
///
/// JavaScript's date-time string format: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`
/// (UTC), and those with `THH:mm`, `:ss` and `.sss` and an offset or `Z`.
/// A date-time without an offset is local time in JavaScript; the workers
/// run in UTC, so it is read as UTC here. Other formats V8 accepts beyond the
/// specification (`Oct 29 2026`) read as invalid.
pub(crate) fn parse_js_date(text: &str) -> Option<String> {
    let (date, time) = match text.split_once('T') {
        Some((date, time)) => (date, Some(time)),
        None => (text, None),
    };
    let mut parts = date.split('-');
    let year = parts.next()?;
    let month = parts.next().unwrap_or("01");
    let day = parts.next().unwrap_or("01");
    if parts.next().is_some()
        || year.len() != 4
        || month.len() != 2
        || day.len() != 2
        || ![year, month, day]
            .iter()
            .all(|part| part.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let (clock, offset) = match time {
        None => ("00:00:00".to_owned(), "Z".to_owned()),
        Some(time) => {
            let split = time
                .find(['Z', '+', '-'])
                .map_or((time, "Z"), |index| (&time[..index], &time[index..]));
            let (clock, offset) = split;
            let mut fields = clock.split(':');
            let hours = fields.next()?;
            let minutes = fields.next()?;
            let seconds = fields.next().unwrap_or("00");
            if fields.next().is_some() || hours.len() != 2 || minutes.len() != 2 {
                return None;
            }
            let (whole, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
            if whole.len() != 2
                || (seconds.contains('.') && fraction.is_empty())
                || ![hours, minutes, whole, fraction]
                    .iter()
                    .all(|part| part.bytes().all(|b| b.is_ascii_digit()))
            {
                return None;
            }
            // JavaScript keeps milliseconds only.
            let millis: String = fraction.chars().chain("000".chars()).take(3).collect();
            let offset = if offset == "Z" || offset.len() == 6 {
                offset.to_owned()
            } else {
                return None;
            };
            (format!("{hours}:{minutes}:{whole}.{millis}"), offset)
        }
    };
    let iso = format!("{year}-{month}-{day}T{clock}{offset}");
    let parsed = OffsetDateTime::parse(&iso, &Rfc3339).ok()?;
    Some(weldsuite_events::iso_timestamp(parsed))
}

/// Names `Object.prototype` answers for: `key in {}` is true for them, and
/// assigning `__proto__` on a plain object sets nothing.
const OBJECT_PROTOTYPE: [&str; 12] = [
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

/// `key in object` is true for every plain object.
pub(crate) fn inherited_key(key: &str) -> bool {
    OBJECT_PROTOTYPE.contains(&key)
}

/// A plain object used as a string map (`Record<string, string>`): insertion
/// order, a repeated key keeps its first place, and `__proto__` is never
/// stored (assigning a string to it does nothing).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct JsRecord(Vec<(String, String)>);

impl JsRecord {
    /// `record[key] = value`.
    pub(crate) fn set(&mut self, key: &str, value: String) {
        if key == "__proto__" {
            return;
        }
        match self.0.iter_mut().find(|(existing, _)| existing == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
    }

    /// `key in record`.
    pub(crate) fn has(&self, key: &str) -> bool {
        inherited_key(key) || self.0.iter().any(|(existing, _)| existing == key)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    /// `Object.entries(record)`.
    pub(crate) fn entries(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    /// `Object.keys(record)`.
    pub(crate) fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(k, _)| k.as_str())
    }

    /// The record as JSON, in its key order.
    pub(crate) fn to_json(&self) -> serde_json::Value {
        serde_json::Value::Object(
            self.0
                .iter()
                .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_is_javascripts() {
        assert_eq!(trim("\u{feff} a \u{a0}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn utf16_slices() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_tail("sk_live_0123456789", 4), "6789");
        assert_eq!(utf16_tail("ab😀", 1), "\u{fffd}");
        assert_eq!(utf16_slice("abcdef", 0, 40), "abcdef");
    }

    #[test]
    fn parse_int_is_javascripts() {
        assert_eq!(parse_int("25", 10), Some(25.0));
        assert_eq!(parse_int(" -7x", 10), Some(-7.0));
        assert_eq!(parse_int("1e3", 10), Some(1.0));
        assert_eq!(parse_int("abc", 10), None);
        assert_eq!(parse_int("", 10), None);
        assert_eq!(parse_int("az", 16), Some(10.0));
        assert_eq!(parse_int("0x1f", 16), Some(31.0));
        assert_eq!(parse_int("zz", 16), None);
        assert_eq!(clamped_limit(None, 25, 1, 100), 25);
        assert_eq!(clamped_limit(Some("500"), 25, 1, 100), 100);
        assert_eq!(clamped_limit(Some("-3"), 25, 1, 100), 1);
        assert_eq!(clamped_limit(Some("nope"), 50, 1, 200), 50);
    }

    #[test]
    fn dates_parse_like_new_date() {
        assert_eq!(
            parse_js_date("2026-10-29T07:00:00.123456Z").as_deref(),
            Some("2026-10-29T07:00:00.123Z")
        );
        assert_eq!(
            parse_js_date("2026-10-29").as_deref(),
            Some("2026-10-29T00:00:00.000Z")
        );
        assert_eq!(
            parse_js_date("2026-10-29T08:00:00+01:00").as_deref(),
            Some("2026-10-29T07:00:00.000Z")
        );
        assert_eq!(parse_js_date("garbage"), None);
        assert_eq!(parse_js_date("2026-13-01"), None);
    }

    #[test]
    fn records_behave_like_plain_objects() {
        let mut record = JsRecord::default();
        record.set("B", "1".to_owned());
        record.set("A", "2".to_owned());
        record.set("B", "3".to_owned());
        record.set("__proto__", "x".to_owned());
        assert_eq!(
            record.entries().collect::<Vec<_>>(),
            [("B", "3"), ("A", "2")]
        );
        assert!(record.has("toString"));
        assert!(!record.has("C"));
    }
}
