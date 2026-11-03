//! JavaScript semantics the routes depend on: `new Date()`, `trim()`,
//! `\s`, `String(value)`, `JSON.stringify`'s numbers, UTF-16 lengths.

use serde_json::Value;
use time::OffsetDateTime;

pub(crate) use weldsuite_calendar_domain::js_dates::parse_date;

/// `new Date().toISOString()`, as Drizzle binds it.
pub(crate) fn now_iso() -> String {
    weldsuite_events::iso_timestamp(OffsetDateTime::now_utc())
}

/// `Date.now()`.
pub(crate) fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}

/// `new Date(millis).toISOString()`.
pub(crate) fn iso(millis: i64) -> String {
    weldsuite_calendar_domain::iso(millis)
}

/// `new Date(text).toISOString()`, `None` for an Invalid Date (which throws
/// when Drizzle binds it).
pub(crate) fn date_iso(text: &str) -> Option<String> {
    parse_date(text).map(iso)
}

/// A `timestamp` column as `to_jsonb` writes it, in milliseconds (UTC, as
/// Drizzle reads it).
pub(crate) fn stamp_ms(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(weldsuite_db::js_timestamp)
        .and_then(|iso| parse_date(&iso))
}

/// JavaScript's `\s` (and what `trim()` removes).
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `text.trim()`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// The first `units` UTF-16 code units of `text` (`slice(0, units)`).
pub(crate) fn utf16_prefix(text: &str, units: usize) -> String {
    let encoded: Vec<u16> = text.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&encoded)
}

/// A number as `JSON.parse` gives it to the route: integral values without
/// a fraction, so `jsonb` keeps `15`, not `15.0`.
pub(crate) fn js_number(value: &Value) -> Value {
    if let Value::Number(number) = value
        && number.is_f64()
        && let Some(float) = number.as_f64()
        && float.fract() == 0.0
        && float.abs() < 9.007_199_254_740_992e15
    {
        #[allow(clippy::cast_possible_truncation)]
        return Value::from(float as i64);
    }
    value.clone()
}

/// `String(value)` for what a JSON body holds.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::String(text) => text.clone(),
        Value::Number(_) => match js_number(value) {
            Value::Number(number) => number.to_string(),
            _ => String::new(),
        },
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn javascript_semantics() {
        assert_eq!(js_trim("\u{feff} a \u{a0}"), "a");
        assert!(!is_js_space('\u{85}'));
        assert_eq!(utf16_prefix("a😀b", 2), "a\u{fffd}");
        assert_eq!(js_number(&json!(15.0)), json!(15));
        assert_eq!(js_number(&json!(1.5)), json!(1.5));
        assert_eq!(js_string(&json!([1, null, "x"])), "1,,x");
        assert_eq!(
            date_iso("2030-03-01").as_deref(),
            Some("2030-03-01T00:00:00.000Z")
        );
        assert_eq!(date_iso("someday"), None);
    }
}
