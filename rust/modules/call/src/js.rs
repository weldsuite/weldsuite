//! JavaScript semantics the worker's code leans on: truthiness, `String(x)`,
//! `parseInt`, `encodeURIComponent`, `URLSearchParams`, `atob`, `btoa` and
//! objects whose keys keep their insertion order.

use std::fmt::Write as _;

use base64::Engine;
use base64::alphabet::STANDARD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde_json::Value;

/// `Boolean(value)`.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a || b || …`: the first truthy value, else the last one.
pub(crate) fn or<'a>(values: &[&'a Value]) -> &'a Value {
    for value in values {
        if truthy(value) {
            return value;
        }
    }
    values.last().copied().unwrap_or(&Value::Null)
}

/// `String(value)` for what JSON can hold (`undefined` reads as `null`
/// here, which callers rule out first).
pub(crate) fn string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(n) => number(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// A number as JavaScript prints it (integral values without a fraction).
pub(crate) fn number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if n.fract() == 0.0 && n.abs() < 1e21 {
        #[allow(clippy::cast_possible_truncation)]
        return format!("{}", n as i64);
    }
    let text = format!("{n}");
    text
}

/// A JSON number for `n`: integral values as integers, as `JSON.stringify`
/// writes them.
pub(crate) fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        #[allow(clippy::cast_possible_truncation)]
        return Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// `Number.parseInt(text, 10)`: the leading integer, `None` for `NaN`.
pub(crate) fn parse_int(text: &str) -> Option<i64> {
    let trimmed = weldsuite_kit::validation::js_trim(text);
    let (negative, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let value: i64 = digits[..end].parse().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

/// `Number.parseFloat(text)`: the leading decimal, `None` for `NaN`.
pub(crate) fn parse_float(text: &str) -> Option<f64> {
    let trimmed = weldsuite_kit::validation::js_trim(text);
    let bytes = trimmed.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end = 1;
    }
    if trimmed[end..].starts_with("Infinity") {
        let sign = if bytes.first() == Some(&b'-') {
            -1.0
        } else {
            1.0
        };
        return Some(sign * f64::INFINITY);
    }
    let digits_start = end;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    let mut seen_digit = end > digits_start;
    if bytes.get(end) == Some(&b'.') {
        let mut after = end + 1;
        while bytes.get(after).is_some_and(u8::is_ascii_digit) {
            after += 1;
        }
        if after > end + 1 {
            seen_digit = true;
        }
        if seen_digit {
            end = after;
        }
    }
    if !seen_digit {
        return None;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let mut after = end + 1;
        if matches!(bytes.get(after), Some(b'+' | b'-')) {
            after += 1;
        }
        let exp_start = after;
        while bytes.get(after).is_some_and(u8::is_ascii_digit) {
            after += 1;
        }
        if after > exp_start {
            end = after;
        }
    }
    trimmed[..end].parse().ok()
}

/// `n.toFixed(2)`: the exact binary value rounded to two decimals, a tie
/// away from zero (Rust's own formatting breaks ties to even).
pub(crate) fn to_fixed2(n: f64) -> String {
    if !n.is_finite() {
        return number(n);
    }
    let sign = if n < 0.0 { "-" } else { "" };
    let exact = format!("{:.60}", n.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let tie = fraction.as_bytes().get(2) == Some(&b'5') && fraction[3..].bytes().all(|b| b == b'0');
    if !tie {
        return format!("{sign}{:.2}", n.abs());
    }
    let cents: u128 = format!("{whole}{}", &fraction[..2]).parse().unwrap_or(0) + 1;
    format!("{sign}{}.{:02}", cents / 100, cents % 100)
}

/// `encodeURIComponent(text)`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `new URLSearchParams(pairs).toString()`.
pub(crate) fn search_params(pairs: &[(&str, &str)]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

/// `btoa(text)` for the ASCII JSON the worker encodes.
pub(crate) fn btoa(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
}

/// `atob(text)` (forgiving base64): ASCII whitespace ignored, padding
/// optional, trailing bits allowed; `None` where it throws.
pub(crate) fn atob(text: &str) -> Option<Vec<u8>> {
    let mut cleaned: String = text
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\u{c}' | '\r' | ' '))
        .collect();
    if cleaned.len().is_multiple_of(4) {
        if cleaned.ends_with("==") {
            cleaned.truncate(cleaned.len() - 2);
        } else if cleaned.ends_with('=') {
            cleaned.truncate(cleaned.len() - 1);
        }
    }
    if cleaned.len() % 4 == 1
        || !cleaned
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    {
        return None;
    }
    let engine = GeneralPurpose::new(
        &STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::RequireNone),
    );
    engine.decode(cleaned).ok()
}

/// `text.slice(0, n)` in UTF-16 units.
pub(crate) fn slice_utf16(text: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// A JSON object whose keys keep the order they were added in, as
/// `JSON.stringify` writes an object literal (`serde_json` sorts them).
#[derive(Debug, Default)]
pub(crate) struct Ordered(Vec<(String, Value)>);

impl Ordered {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub(crate) fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.0.push((key.to_owned(), value.into()));
        self
    }

    /// `JSON.stringify(object)`.
    pub(crate) fn stringify(&self) -> String {
        let fields: Vec<String> = self
            .0
            .iter()
            .map(|(key, value)| {
                format!(
                    "{}:{}",
                    Value::String(key.clone()),
                    serde_json::to_string(value).unwrap_or_default()
                )
            })
            .collect();
        format!("{{{}}}", fields.join(","))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn javascript_helpers_behave_like_javascript() {
        assert_eq!(parse_int("25"), Some(25));
        assert_eq!(parse_int(" 10abc"), Some(10));
        assert_eq!(parse_int("-3"), Some(-3));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_float("1.50"), Some(1.5));
        assert_eq!(parse_float(".5"), Some(0.5));
        assert_eq!(parse_float("2e3x"), Some(2000.0));
        assert_eq!(parse_float(""), None);
        assert_eq!(parse_float("abc"), None);
        assert_eq!(to_fixed2(1.0 * 1.2), "1.20");
        assert_eq!(to_fixed2(10.0 + 150.0 / 100.0), "11.50");
        assert_eq!(to_fixed2(1.125), "1.13");
        assert_eq!(to_fixed2(0.5), "0.50");
        assert_eq!(to_fixed2(1.005), "1.00");
        assert_eq!(encode_uri_component("a b/c+d"), "a%20b%2Fc%2Bd");
        assert_eq!(
            search_params(&[("filter[country_code]", "NL"), ("q", "a b")]),
            "filter%5Bcountry_code%5D=NL&q=a+b"
        );
        assert_eq!(atob("eyJhIjoxfQ==").as_deref(), Some(&b"{\"a\":1}"[..]));
        assert_eq!(atob("eyJhIjoxfQ").as_deref(), Some(&b"{\"a\":1}"[..]));
        assert_eq!(atob("!!"), None);
        assert_eq!(string(&json!(3)), "3");
        assert_eq!(string(&json!(1.5)), "1.5");
        assert_eq!(string(&json!({})), "[object Object]");
        assert_eq!(slice_utf16("héllo", 2), "hé");
        assert_eq!(
            Ordered::new()
                .with("callId", "c")
                .with("workspaceId", "w")
                .stringify(),
            r#"{"callId":"c","workspaceId":"w"}"#
        );
        assert!(!truthy(&json!("")));
        assert_eq!(or(&[&json!(""), &json!("x")]), &json!("x"));
        assert_eq!(or(&[&json!(""), &json!(null)]), &json!(null));
    }
}
