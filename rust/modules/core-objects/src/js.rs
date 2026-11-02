//! JSON as JavaScript sees it, where the routes can tell: the key order of
//! objects (`JSON.stringify` compares by it), how numbers print, `String(x)`
//! and `asText(x)` (`@weldsuite/text`).
//!
//! `serde_json` keeps object keys sorted, which loses two orders the routes
//! depend on: a request body's (what `JSON.parse` built) and a `jsonb`
//! column's (shorter keys first, then bytewise, which is how Drizzle hands
//! the object back). [`Js`] keeps either.

use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value, json};

/// A JSON value with its object keys in JavaScript's order.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Js {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Js>),
    Object(Vec<(String, Js)>),
}

impl Js {
    /// A `jsonb` value as Drizzle returns it: keys in `jsonb`'s order.
    pub(crate) fn from_jsonb(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(flag) => Self::Bool(*flag),
            Value::Number(number) => Self::Number(number.as_f64().unwrap_or(f64::NAN)),
            Value::String(text) => Self::String(text.clone()),
            Value::Array(items) => Self::Array(items.iter().map(Self::from_jsonb).collect()),
            Value::Object(map) => {
                let mut entries: Vec<(String, Self)> = map
                    .iter()
                    .map(|(key, value)| (key.clone(), Self::from_jsonb(value)))
                    .collect();
                entries.sort_by(|(a, _), (b, _)| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
                Self::Object(js_key_order(entries))
            }
        }
    }

    /// The `serde_json` value (key order is lost).
    pub(crate) fn to_value(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(flag) => Value::Bool(*flag),
            Self::Number(number) => number_value(*number),
            Self::String(text) => Value::String(text.clone()),
            Self::Array(items) => Value::Array(items.iter().map(Self::to_value).collect()),
            Self::Object(entries) => Value::Object(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), value.to_value()))
                    .collect::<Map<String, Value>>(),
            ),
        }
    }

    /// `obj[key]` of an object.
    pub(crate) fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// `''`, `null` or absent: what the custom field code calls empty.
    pub(crate) fn is_empty_value(value: Option<&Self>) -> bool {
        match value {
            None | Some(Self::Null) => true,
            Some(Self::String(text)) => text.is_empty(),
            Some(_) => false,
        }
    }
}

/// A number as `JSON.stringify` writes it into a value: whole numbers as
/// integers, non-finite as `null`.
pub(crate) fn number_value(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        json!(number as i64)
    } else if number.is_finite() {
        json!(number)
    } else {
        Value::Null
    }
}

/// `jsonb` keeps `2.0` as written; JavaScript reads it as `2`. Whole floats
/// become integers, recursively, before a value is written to `jsonb`.
pub(crate) fn whole_numbers(value: &Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => {
            number_value(number.as_f64().unwrap_or(f64::NAN))
        }
        Value::Array(items) => Value::Array(items.iter().map(whole_numbers).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), whole_numbers(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Is `key` an array index (`"0"`, `"17"`, below 2^32 - 1)? JavaScript
/// lists those keys first, in numeric order.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// Entries as a JavaScript object holds them: a repeated key keeps its first
/// position with the last value, and array-index keys come first.
fn js_key_order(entries: Vec<(String, Js)>) -> Vec<(String, Js)> {
    let mut unique: Vec<(String, Js)> = Vec::with_capacity(entries.len());
    for (key, value) in entries {
        if let Some(slot) = unique.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            unique.push((key, value));
        }
    }
    let (mut indexes, named): (Vec<_>, Vec<_>) = unique
        .into_iter()
        .partition(|(key, _)| array_index(key).is_some());
    indexes.sort_by_key(|(key, _)| array_index(key));
    indexes.extend(named);
    indexes
}

impl<'de> Deserialize<'de> for Js {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(JsVisitor)
    }
}

struct JsVisitor;

impl<'de> Visitor<'de> for JsVisitor {
    type Value = Js;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Js, E> {
        Ok(Js::Bool(value))
    }

    #[allow(clippy::cast_precision_loss)]
    fn visit_i64<E>(self, value: i64) -> Result<Js, E> {
        Ok(Js::Number(value as f64))
    }

    #[allow(clippy::cast_precision_loss)]
    fn visit_u64<E>(self, value: u64) -> Result<Js, E> {
        Ok(Js::Number(value as f64))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Js, E> {
        Ok(Js::Number(value))
    }

    fn visit_str<E>(self, value: &str) -> Result<Js, E> {
        Ok(Js::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Js, E> {
        Ok(Js::String(value))
    }

    fn visit_unit<E>(self) -> Result<Js, E> {
        Ok(Js::Null)
    }

    fn visit_none<E>(self) -> Result<Js, E> {
        Ok(Js::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Js, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<Js>()? {
            items.push(item);
        }
        Ok(Js::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Js, A::Error> {
        let mut entries = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, Js>()? {
            entries.push((key, value));
        }
        Ok(Js::Object(js_key_order(entries)))
    }
}

/// The request body in JavaScript's key order; `Js::Null` when it isn't
/// JSON (the validator has refused it by then).
pub(crate) fn parse_body(body: &[u8]) -> Js {
    serde_json::from_slice(body).unwrap_or(Js::Null)
}

/// `String(number)`.
pub(crate) fn number_text(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_owned();
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    let abs = number.abs();
    if (1e-6..1e21).contains(&abs) {
        return format!("{number}");
    }
    // `1.5e21` → `1.5e+21`; `1e-7` stays.
    let text = format!("{number:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// `JSON.stringify(value)`.
pub(crate) fn stringify(value: &Js) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_json(value: &Js, out: &mut String) {
    match value {
        Js::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Js::Number(number) if number.is_finite() => out.push_str(&number_text(*number)),
        Js::Null | Js::Number(_) => out.push_str("null"),
        Js::String(text) => out.push_str(&quote(text)),
        Js::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Js::Object(entries) => {
            out.push('{');
            for (i, (key, item)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&quote(key));
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// `String(value)`.
pub(crate) fn js_string(value: &Js) -> String {
    match value {
        Js::Null => "null".to_owned(),
        Js::Bool(flag) => flag.to_string(),
        Js::Number(number) => number_text(*number),
        Js::String(text) => text.clone(),
        // `Array.prototype.join`: null items are empty.
        Js::Array(items) => items
            .iter()
            .map(|item| match item {
                Js::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Js::Object(_) => "[object Object]".to_owned(),
    }
}

/// `asText(value)` (`@weldsuite/text`): strings as they are, arrays joined
/// with commas, objects as JSON.
pub(crate) fn as_text(value: &Js) -> String {
    match value {
        Js::Array(items) => items
            .iter()
            .map(|item| match item {
                Js::Null => String::new(),
                other => as_text(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Js::Object(_) => stringify(value),
        other => js_string(other),
    }
}

/// `text.slice(0, max)` in UTF-16 units. A surrogate pair cut in half leaves
/// a lone surrogate, which becomes U+FFFD on its way to the database.
pub(crate) fn slice_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        let width = c.len_utf16();
        if units + width > max {
            if units < max {
                out.push('\u{fffd}');
            }
            break;
        }
        units += width;
        out.push(c);
    }
    out
}

/// `new Date(text)` for the ISO forms JavaScript parses: a date (`2026`,
/// `2026-03`, `2026-03-04`, or a six-digit signed year), optionally a time
/// (`T`, `t` or a space; `HH:mm`, seconds, a fraction) and an offset (`Z`,
/// `±HH:mm`, `±HHmm`). Days past the end of the month roll over, as in
/// JavaScript. A time without an offset is UTC, the Workers' local time.
/// Other forms (V8's legacy parser) are not read: `None`, an invalid date.
/// The answer is `toISOString()`.
pub(crate) fn js_date(text: &str) -> Option<String> {
    let mut p = Cursor {
        bytes: text.as_bytes(),
        at: 0,
    };
    let year = match p.peek() {
        Some(sign @ (b'+' | b'-')) => {
            p.at += 1;
            let digits = p.digits(6, 6)?;
            if sign == b'-' && digits == 0 {
                return None;
            }
            if sign == b'-' { -digits } else { digits }
        }
        _ => p.digits(4, 4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if p.eat(b'-') {
        month = p.digits(2, 2)?;
        if p.eat(b'-') {
            day = p.digits(2, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut millis_of_day = 0;
    let mut offset_minutes = 0;
    if matches!(p.peek(), Some(b'T' | b't' | b' ')) {
        p.at += 1;
        let hour = p.digits(2, 2)?;
        if !p.eat(b':') {
            return None;
        }
        let minute = p.digits(2, 2)?;
        let mut second = 0;
        let mut millis = 0;
        if p.eat(b':') {
            second = p.digits(2, 2)?;
            if p.eat(b'.') {
                let start = p.at;
                while p.peek().is_some_and(|b| b.is_ascii_digit()) {
                    p.at += 1;
                }
                let fraction = &text[start..p.at];
                if fraction.is_empty() {
                    return None;
                }
                let padded: String = fraction.chars().chain("000".chars()).take(3).collect();
                millis = padded.parse::<i64>().ok()?;
            }
        }
        if hour > 24
            || minute > 59
            || second > 59
            || (hour == 24 && (minute, second, millis) != (0, 0, 0))
        {
            return None;
        }
        millis_of_day = ((hour * 60 + minute) * 60 + second) * 1000 + millis;
        match p.peek() {
            Some(b'Z' | b'z') => p.at += 1,
            Some(sign @ (b'+' | b'-')) => {
                p.at += 1;
                let hours = p.digits(2, 2)?;
                p.eat(b':');
                let minutes = p.digits(2, 2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                let total = hours * 60 + minutes;
                offset_minutes = if sign == b'-' { -total } else { total };
            }
            _ => {}
        }
    }
    if p.at != text.len() {
        return None;
    }
    let days = days_from_civil(year, month, 1) + day - 1;
    let epoch_millis = days * 86_400_000 + millis_of_day - offset_minutes * 60_000;
    // `toISOString()` throws past ±8.64e15 ms.
    if epoch_millis.abs() > 8_640_000_000_000_000 {
        return None;
    }
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(epoch_millis) * 1_000_000)
        .ok()?;
    Some(weldsuite_events::iso_timestamp(at))
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn digits(&mut self, min: usize, max: usize) -> Option<i64> {
        let start = self.at;
        while self.at - start < max && self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.at += 1;
        }
        if self.at - start < min {
            return None;
        }
        std::str::from_utf8(&self.bytes[start..self.at])
            .ok()?
            .parse()
            .ok()
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `Number.parseInt(text, 10)`: leading whitespace, a sign, then as many
/// digits as there are; `None` (NaN) without any.
pub(crate) fn parse_int(text: &str) -> Option<i64> {
    let text = weldsuite_kit::validation::js_trim(text);
    let (negative, rest) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    // Beyond i64 the value is clamped anyway by every caller.
    let value = digits.parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn objects_keep_javascripts_key_order() {
        let body: Js = serde_json::from_str(r#"{"b":1,"a":{"z":1,"y":2},"2":true,"1":null,"b":3}"#)
            .expect("json");
        assert_eq!(
            stringify(&body),
            r#"{"1":null,"2":true,"b":3,"a":{"z":1,"y":2}}"#
        );
        let stored =
            Js::from_jsonb(&json!({ "value": "web", "color": "blue", "label": "Web", "id": 1 }));
        assert_eq!(
            stringify(&stored),
            r#"{"id":1,"color":"blue","label":"Web","value":"web"}"#
        );
    }

    #[test]
    fn numbers_and_text_print_like_javascript() {
        assert_eq!(number_text(5.0), "5");
        assert_eq!(number_text(12.5), "12.5");
        assert_eq!(number_text(-0.0), "0");
        assert_eq!(number_text(1e21), "1e+21");
        assert_eq!(number_text(1.5e-7), "1.5e-7");
        assert_eq!(number_text(0.000_001), "0.000001");
        assert_eq!(number_text(1e20), "100000000000000000000");
        let list: Js = serde_json::from_str(r#"["a",null,2,{"k":true},[1,2]]"#).expect("json");
        assert_eq!(as_text(&list), r#"a,,2,{"k":true},1,2"#);
        assert_eq!(js_string(&list), "a,,2,[object Object],1,2");
        assert_eq!(slice_utf16("ab😀c", 3), "ab\u{fffd}");
        assert_eq!(slice_utf16("ab😀c", 4), "ab😀");
    }

    #[test]
    fn dates_parse_like_javascripts_iso_forms() {
        let cases = [
            ("2026-03-04", Some("2026-03-04T00:00:00.000Z")),
            ("2026-02-30", Some("2026-03-02T00:00:00.000Z")),
            ("2026", Some("2026-01-01T00:00:00.000Z")),
            ("2026-03", Some("2026-03-01T00:00:00.000Z")),
            ("+002026-03-04", Some("2026-03-04T00:00:00.000Z")),
            ("2026-03-04T24:00:00Z", Some("2026-03-05T00:00:00.000Z")),
            (
                "2026-03-04T10:00:00.123456Z",
                Some("2026-03-04T10:00:00.123Z"),
            ),
            ("2026-03-04t10:00z", Some("2026-03-04T10:00:00.000Z")),
            ("2026-03-04 10:00Z", Some("2026-03-04T10:00:00.000Z")),
            ("2026-03-04T10:00+01:00", Some("2026-03-04T09:00:00.000Z")),
            ("2026-03-04T10:00:00+0100", Some("2026-03-04T09:00:00.000Z")),
            ("2026-13-01", None),
            ("someday", None),
            ("true", None),
        ];
        for (text, expected) in cases {
            assert_eq!(js_date(text).as_deref(), expected, "{text}");
        }
    }

    #[test]
    fn parse_int_reads_a_prefix() {
        assert_eq!(parse_int(" 12abc"), Some(12));
        assert_eq!(parse_int("-5"), Some(-5));
        assert_eq!(parse_int("1e3"), Some(1));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int(""), None);
    }
}
