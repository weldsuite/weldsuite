//! JavaScript semantics the TypeScript code leans on.

use std::fmt::Write as _;

use serde_json::Value;

pub(crate) use weldsuite_kit::validation::js_trim;

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(value: &str) -> String {
    encode(value, |byte| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
    })
}

/// The Cloudflare SDK's `encodeURIPath`: everything but RFC 3986 `pchar`.
pub(crate) fn encode_uri_path(value: &str) -> String {
    encode(value, |byte| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'.'
                    | b'_'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b':'
                    | b'@'
            )
    })
}

fn encode(value: &str, keep: impl Fn(u8) -> bool) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if keep(byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `URLSearchParams` serialisation of one value
/// (`application/x-www-form-urlencoded`: space as `+`).
pub(crate) fn form_value(value: &str) -> String {
    form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// `Number.parseInt(text, 10)`: `None` for `NaN`.
pub(crate) fn parse_int(text: &str) -> Option<i64> {
    let trimmed = text.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let (negative, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let end = digits
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let value: i64 = digits[..end].parse().ok()?;
    Some(if negative { -value } else { value })
}

/// `Number(text)` for a string: `None` for `NaN`.
pub(crate) fn number_of(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// `Number.parseFloat(String(value))` of a JSON value (a `numeric` column
/// read as text, or a number): `None` for `NaN`.
pub(crate) fn parse_float(value: &Value) -> Option<f64> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    let trimmed = text.trim_start();
    let end = trimmed
        .char_indices()
        .take_while(|(index, c)| {
            c.is_ascii_digit() || *c == '.' || ((*c == '-' || *c == '+') && *index == 0)
        })
        .map(|(index, c)| index + c.len_utf8())
        .last()
        .unwrap_or(0);
    trimmed[..end].parse::<f64>().ok()
}

/// `Math.round`.
pub(crate) fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// A finite number as JSON, integral values as integers (`612`, not `612.0`).
pub(crate) fn number_json(value: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// `String(value)` of a JSON value.
pub(crate) fn as_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number
            .as_f64()
            .map_or_else(|| number.to_string(), |n| number_text(n)),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    as_text(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => value.to_string(),
    }
}

/// `String(number)` for a finite number.
pub(crate) fn number_text(value: f64) -> String {
    #[allow(clippy::cast_possible_truncation)]
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{}", value as i128);
    }
    format!("{value}")
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// A string column of a row (`row.key`), `None` for null or absent.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `name.split('.').slice(1).join('.').replace(/^\./, '').toLowerCase()`.
pub(crate) fn tld_of(name: &str) -> String {
    let rest = name.split('.').skip(1).collect::<Vec<_>>().join(".");
    rest.strip_prefix('.').unwrap_or(&rest).to_lowercase()
}

/// `text.slice(0, n)` in UTF-16 units.
pub(crate) fn slice_utf16(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// A random UUID v4 without its dashes (`crypto.randomUUID().replaceAll('-', '')`).
pub(crate) fn random_uuid_hex() -> String {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    hex::encode(bytes)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn numbers_read_like_javascript() {
        assert_eq!(parse_int("90"), Some(90));
        assert_eq!(parse_int(" 12.7"), Some(12));
        assert_eq!(parse_int("-5x"), Some(-5));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_float(&json!("12.99")), Some(12.99));
        assert_eq!(parse_float(&json!("x")), None);
        assert_eq!(number_of(""), Some(0.0));
        assert_eq!(number_of("10"), Some(10.0));
        assert_eq!(number_of("1a"), None);
        assert!((round(1299.000_000_000_000_2) - 1299.0).abs() < f64::EPSILON);
        assert_eq!(number_json(612.0), json!(612));
        assert_eq!(as_text(&json!(["a", null, 2])), "a,,2");
    }

    #[test]
    fn encodings_match_the_browser() {
        assert_eq!(encode_uri_component("a b/c@d"), "a%20b%2Fc%40d");
        assert_eq!(encode_uri_path("a b/c@d"), "a%20b%2Fc@d");
        assert_eq!(form_value("a b&c"), "a+b%26c");
        assert_eq!(tld_of("example.co.uk"), "co.uk");
        assert_eq!(tld_of("localhost"), "");
        assert_eq!(random_uuid_hex().len(), 32);
    }
}
