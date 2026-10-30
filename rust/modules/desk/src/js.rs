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

/// `a || b` on optional strings: an empty string is falsy.
#[allow(dead_code)]
pub(crate) fn or_else<'a>(a: Option<&'a str>, b: Option<&'a str>) -> Option<&'a str> {
    a.filter(|a| !a.is_empty()).or(b)
}

/// A string field of a row; `None` when null or missing.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `new Date(text).toISOString()` for the ISO shapes JavaScript parses
/// (a date alone is UTC midnight; a date-time without an offset is the
/// worker's time zone, UTC); `None` where it is an Invalid Date.
pub(crate) fn js_date_iso(text: &str) -> Option<String> {
    use time::format_description::well_known::Rfc3339;
    use time::macros::format_description;
    let text = text.trim();
    if let Ok(parsed) = time::OffsetDateTime::parse(text, &Rfc3339) {
        return Some(weldsuite_events::iso_timestamp(parsed));
    }
    if let Ok(date) = time::Date::parse(text, format_description!("[year]-[month]-[day]")) {
        return Some(weldsuite_events::iso_timestamp(
            date.midnight().assume_utc(),
        ));
    }
    for format in [
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond]"),
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]"),
        format_description!("[year]-[month]-[day]T[hour]:[minute]"),
    ] {
        if let Ok(local) = time::PrimitiveDateTime::parse(text, format) {
            return Some(weldsuite_events::iso_timestamp(local.assume_utc()));
        }
    }
    None
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
        assert_eq!(js_slice(vec![1, 2, 3], -1), vec![1, 2]);
        assert_eq!(js_slice(vec![1, 2, 3], 5), vec![1, 2, 3]);
    }
}
