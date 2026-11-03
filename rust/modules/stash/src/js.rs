//! JavaScript semantics the routes depend on.

use serde_json::Value;
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

/// A query parameter that is there and not empty (`if (q.x)`).
pub(crate) fn query_set(query: Option<&str>, name: &str) -> Option<String> {
    query_param(query, name).filter(|value| !value.is_empty())
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

/// `.limit(n)`: Drizzle leaves the LIMIT out when it is `NaN` or negative
/// (`NULL` is no limit in Postgres).
pub(crate) fn sql_limit_of(n: f64) -> Option<i64> {
    if n.is_nan() || n < 0.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(n as i64)
}

/// `.limit(limit + 1)`.
pub(crate) fn sql_limit(limit: f64) -> Option<i64> {
    sql_limit_of(limit + 1.0)
}

/// `Number.parseInt(raw, 10)`: `None` for `NaN`.
pub(crate) fn js_parse_int(raw: &str) -> Option<f64> {
    let rest =
        raw.trim_start_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
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

/// `rows.slice(0, end)` with JavaScript's negative `end`.
pub(crate) fn js_slice<T>(mut rows: Vec<T>, end: i64) -> Vec<T> {
    let len = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    let end = if end < 0 {
        (len + end).max(0)
    } else {
        end.min(len)
    };
    rows.truncate(usize::try_from(end).unwrap_or(0));
    rows
}

/// A string field of a row; `None` when null or missing.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// A string field that is set and not empty (JavaScript's truthiness).
pub(crate) fn truthy<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    text(row, key).filter(|value| !value.is_empty())
}

/// An integer field of a row (`row.x ?? 0`).
pub(crate) fn int(row: &Value, key: &str) -> i64 {
    row.get(key).and_then(Value::as_i64).unwrap_or(0)
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

/// `String(value)` of a JSON number as JavaScript holds it.
pub(crate) fn json_number_text(value: &Value) -> String {
    value
        .as_f64()
        .map_or_else(|| value.to_string(), number_text)
}

/// `number.toFixed(2)`: the nearest hundredth, a tie going away from zero
/// (JavaScript picks the larger `n`; Rust's formatting rounds a tie to even).
pub(crate) fn to_fixed_2(number: f64) -> String {
    let eighths = number * 8.0;
    // A double sits exactly halfway between two hundredths only when it is
    // an odd number of eighths (x.125, x.375, x.625, x.875).
    #[allow(clippy::cast_possible_truncation)]
    let tie = eighths.fract() == 0.0 && eighths.abs() < 9.0e15 && (eighths as i64) % 2 != 0;
    if tie {
        let hundredths = (number.abs() * 100.0).floor() + 1.0;
        let sign = if number < 0.0 { "-" } else { "" };
        return format!("{sign}{:.2}", hundredths / 100.0);
    }
    format!("{number:.2}")
}

/// `n.toString(36).toUpperCase()` for a non-negative integer.
pub(crate) fn base36_upper(mut n: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if n == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[usize::try_from(n % 36).unwrap_or(0)]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `Date.now()`: milliseconds since the epoch.
pub(crate) fn date_now() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis())
}

/// `` `${prefix}-${Date.now().toString(36).toUpperCase()}` ``.
pub(crate) fn time_number(prefix: &str) -> String {
    format!("{prefix}-{}", base36_upper(date_now()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_read_like_the_routes() {
        assert_eq!(js_limit(None, 25.0, 100.0), 25.0);
        assert_eq!(js_limit(Some("10"), 25.0, 100.0), 10.0);
        assert_eq!(js_limit(Some("500"), 25.0, 100.0), 100.0);
        assert_eq!(js_limit(Some("2.9"), 25.0, 100.0), 2.0);
        assert!(js_limit(Some("abc"), 25.0, 100.0).is_nan());
        assert_eq!(sql_limit(f64::NAN), None);
        assert_eq!(sql_limit(-1.0), Some(0));
        assert_eq!(sql_limit(-3.0), None);
        assert_eq!(sql_limit(25.0), Some(26));
        assert_eq!(sql_limit_of(-1.0), None);
        assert_eq!(js_slice(vec![1, 2, 3], -1), vec![1, 2]);
        assert_eq!(js_slice(vec![1, 2, 3], 5), vec![1, 2, 3]);
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(number_text(10.0), "10");
        assert_eq!(number_text(10.5), "10.5");
        assert_eq!(number_text(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(number_text(1e20), "100000000000000000000");
        assert_eq!(number_text(1e21), "1e+21");
        assert_eq!(to_fixed_2(7.5), "7.50");
        assert_eq!(to_fixed_2(0.125), "0.13");
        assert_eq!(to_fixed_2(1.005), "1.00");
        assert_eq!(to_fixed_2(-0.125), "-0.13");
        assert_eq!(to_fixed_2(12.344), "12.34");
        assert_eq!(base36_upper(0), "0");
        assert_eq!(base36_upper(35), "Z");
        assert_eq!(base36_upper(1_767_225_600_000), "MJUOHS00");
    }
}
