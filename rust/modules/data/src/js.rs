//! JavaScript semantics the routes depend on (as in WeldSocial's `js.rs`).

use serde_json::{Number, Value};
use weldsuite_kit::validation::query_values;

/// `c.req.query(name)` (and `c.req.query()[name]`): the first value of a
/// query parameter.
pub(crate) fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query_values(query).get(name).and_then(|value| match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => items.first().and_then(Value::as_str).map(str::to_owned),
        _ => None,
    })
}

/// `Math.min(q.limit ? Number.parseInt(q.limit, 10) : fallback, max)`: the
/// page size as JavaScript holds it, `NaN` included.
pub(crate) fn js_limit(raw: Option<&str>, fallback: f64, max: f64) -> f64 {
    match raw.filter(|raw| !raw.is_empty()) {
        None => fallback.min(max),
        // `Math.min(NaN, max)` is NaN.
        Some(raw) => js_parse_int(raw).map_or(f64::NAN, |value| value.min(max)),
    }
}

/// `.limit(limit + 1)`: Drizzle leaves the LIMIT out when it is `NaN` or
/// negative (`NULL` is no limit in Postgres).
pub(crate) fn sql_limit(limit: f64) -> Option<i64> {
    let probe = limit + 1.0;
    if probe.is_nan() || probe < 0.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(probe as i64)
}

/// `Number.parseInt(raw, 10)`: `None` for `NaN`.
pub(crate) fn js_parse_int(raw: &str) -> Option<f64> {
    let rest = raw.trim_start_matches(is_js_space);
    let (negative, rest) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let digits = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return None;
    }
    let value: f64 = digits.parse().ok()?;
    Some(if negative { -value } else { value })
}

/// `rows.slice(0, end)` with JavaScript's `NaN` (0) and negative `end`.
#[allow(clippy::cast_precision_loss)] // a page is far below 2^52 rows
pub(crate) fn js_slice<T>(mut rows: Vec<T>, end: f64) -> Vec<T> {
    let len = rows.len();
    let end = if end.is_nan() {
        0
    } else if end < 0.0 {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let back = (-end).ceil().min(len as f64) as usize;
        len - back
    } else {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let end = end.min(len as f64) as usize;
        end
    };
    rows.truncate(end);
    rows
}

/// JavaScript's `\s` (and what `trim` drops): Unicode white space and the
/// BOM, without U+0085.
pub(crate) fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `text.trim()`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `text.toLowerCase()`.
pub(crate) fn js_lowercase(text: &str) -> String {
    text.to_lowercase()
}

/// `String(number)`: integers without a fraction, the exponent forms
/// JavaScript uses below 1e-6 and from 1e21.
pub(crate) fn js_number_string(number: &Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }
    let value = number.as_f64().unwrap_or(f64::NAN);
    js_f64_string(value)
}

/// `String(value)` of a double.
pub(crate) fn js_f64_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if !(1e-6..1e21).contains(&magnitude) {
        let text = format!("{value:e}");
        return match text.split_once('e') {
            Some((mantissa, exponent)) if !exponent.starts_with('-') => {
                format!("{mantissa}e+{exponent}")
            }
            _ => text,
        };
    }
    if value.fract() == 0.0 {
        #[allow(clippy::cast_possible_truncation)]
        return format!("{}", value as i128);
    }
    format!("{value}")
}

/// `String(value)` of a JSON value.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_string(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// A string field of a row; `None` when null or missing.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `a || b` on optional strings: an empty string is falsy.
pub(crate) fn truthy(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn limits_read_like_the_routes() {
        assert_eq!(js_limit(None, 50.0, 100.0), 50.0);
        assert_eq!(js_limit(Some("10"), 50.0, 100.0), 10.0);
        assert_eq!(js_limit(Some("500"), 50.0, 100.0), 100.0);
        assert_eq!(js_limit(Some("2.9"), 50.0, 100.0), 2.0);
        assert!(js_limit(Some("abc"), 50.0, 100.0).is_nan());
        assert_eq!(sql_limit(f64::NAN), None);
        assert_eq!(sql_limit(-1.0), Some(0));
        assert_eq!(sql_limit(-3.0), None);
        assert_eq!(js_slice(vec![1, 2, 3], -1.0), vec![1, 2]);
        assert_eq!(js_slice(vec![1, 2, 3], 5.0), vec![1, 2, 3]);
        assert_eq!(js_slice(vec![1, 2, 3], f64::NAN), Vec::<i32>::new());
    }

    #[test]
    fn numbers_read_like_string_of_them() {
        assert_eq!(js_string(&json!(3)), "3");
        assert_eq!(js_string(&json!(3.0)), "3");
        assert_eq!(js_string(&json!(1.5)), "1.5");
        assert_eq!(js_f64_string(1e21), "1e+21");
        assert_eq!(js_f64_string(1.5e-7), "1.5e-7");
        assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(js_trim("\u{feff} a \n"), "a");
    }
}
