//! A `.passthrough()` body handed to Drizzle whole: `db.insert(t).values({ id,
//! ...data })` and `db.update(t).set({ ...data })` in the notifications and
//! audit-log routes. Every key of the body that names a column of the table
//! (by its JavaScript property) reaches the SQL; the others are dropped.
//!
//! [`column_values`] reads those keys into one JSON object keyed by the SQL
//! column, each value already in the column's form, so a route binds it as a
//! single `jsonb` parameter and reads `$1->>'title'` per column. What would
//! fail in the database fails here instead, as [`Unwritable`] (the route's
//! 500), so no statement is sent that Postgres would reject:
//!
//! - `null` in a `NOT NULL` column (a missing value in an insert is the
//!   column default; the route checks a required column itself);
//! - a value too long for a `varchar(n)`: more characters than `n`, unless
//!   the excess is all spaces, which Postgres trims on assignment;
//! - a `NUL` character, which neither `text` nor `jsonb` stores;
//! - any non-null value for a timestamp column: Drizzle calls
//!   `value.toISOString()`, and nothing a JSON body holds has it;
//! - a value Postgres cannot read as the column's type.
//!
//! The values are typed as the Workers' driver (neon-http) sends them:
//! strings as they are, numbers as `String(n)`, booleans as `true`/`false`,
//! arrays as a Postgres array literal and objects as JSON text (with
//! `serde_json`'s key order, not the body's); a `boolean` column reads that
//! text as Postgres does (`yes`, `on`, `1`, …). `jsonb` columns take any
//! JSON value (Drizzle stringifies it). The test database (pglite) is
//! stricter: it refuses a non-string for a text column and a non-boolean for
//! a boolean one.

use serde_json::{Map, Value};

/// What a column holds, as far as a body value is concerned.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Kind {
    /// `text`, or `varchar(n)` with its length.
    Text(Option<usize>),
    Bool,
    Json,
    Timestamp,
}

/// A column a body key can reach.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Column {
    /// The Drizzle (JavaScript) property name.
    pub key: &'static str,
    /// The SQL column name.
    pub name: &'static str,
    pub kind: Kind,
    pub not_null: bool,
}

/// `Column` in a table literal: `col("userId", "user_id", Kind::Text(Some(255)), true)`.
pub(crate) const fn col(
    key: &'static str,
    name: &'static str,
    kind: Kind,
    not_null: bool,
) -> Column {
    Column {
        key,
        name,
        kind,
        not_null,
    }
}

/// A body value the database would refuse (logged, then the route's 500).
#[derive(Debug)]
pub(crate) struct Unwritable(pub String);

impl std::fmt::Display for Unwritable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The body's values for `columns`, keyed by SQL column name; a key the body
/// leaves out is left out.
pub(crate) fn column_values(
    columns: &[Column],
    body: &Map<String, Value>,
) -> Result<Map<String, Value>, Unwritable> {
    let mut out = Map::new();
    for column in columns {
        if let Some(value) = body.get(column.key) {
            out.insert(column.name.to_owned(), coerce(column, value)?);
        }
    }
    Ok(out)
}

/// An update needs a column to set: Drizzle drops the keys that name none
/// (the route's own `updatedAt` included, on tables without one), and an
/// empty `SET` is a syntax error.
pub(crate) fn ensure_some_column(
    values: &Map<String, Value>,
    failed: &'static str,
) -> crate::PlatformResult<()> {
    if values.is_empty() {
        return Err(crate::PlatformError::internal(failed, "no column to set"));
    }
    Ok(())
}

/// The new primary key an update sets, when it changes it.
pub(crate) fn new_id<'a>(values: &'a Map<String, Value>, id: &str) -> Option<&'a str> {
    values
        .get("id")
        .and_then(Value::as_str)
        .filter(|new_id| *new_id != id)
}

fn coerce(column: &Column, value: &Value) -> Result<Value, Unwritable> {
    let refuse = |why: &str| Err(Unwritable(format!("{}: {why}", column.name)));
    if value.is_null() {
        return if column.not_null {
            refuse("null value violates the not-null constraint")
        } else {
            Ok(Value::Null)
        };
    }
    match column.kind {
        Kind::Timestamp => refuse("value.toISOString is not a function"),
        Kind::Json => {
            if holds_nul(value) {
                return refuse("\\u0000 cannot be stored in jsonb");
            }
            Ok(value.clone())
        }
        Kind::Text(max) => {
            let text = driver_text(value);
            if text.contains('\0') {
                return refuse("invalid byte sequence 0x00");
            }
            if let Some(max) = max
                && !fits(&text, max)
            {
                return refuse("value too long for the column");
            }
            Ok(Value::String(text))
        }
        Kind::Bool => match value {
            Value::Bool(flag) => Ok(Value::Bool(*flag)),
            other => match pg_bool(&driver_text(other)) {
                Some(flag) => Ok(Value::Bool(flag)),
                None => refuse("invalid input syntax for type boolean"),
            },
        },
    }
}

/// `varchar(max)` takes the text: at most `max` characters, or more whose
/// excess is all spaces (Postgres truncates those).
fn fits(text: &str, max: usize) -> bool {
    text.chars().skip(max).all(|c| c == ' ')
}

fn holds_nul(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains('\0'),
        Value::Array(items) => items.iter().any(holds_nul),
        Value::Object(map) => map.iter().any(|(k, v)| k.contains('\0') || holds_nul(v)),
        _ => false,
    }
}

/// The text the driver sends for a non-null value (node-postgres'
/// `prepareValue`).
pub(crate) fn driver_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => array_literal(items),
        Value::Object(_) => value.to_string(),
    }
}

/// node-postgres' `arrayString`: `{"a","b",NULL,{"c"}}`.
fn array_literal(items: &[Value]) -> String {
    let parts: Vec<String> = items
        .iter()
        .map(|item| match item {
            Value::Null => "NULL".to_owned(),
            Value::Array(inner) => array_literal(inner),
            other => {
                let text = driver_text(other);
                format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
            }
        })
        .collect();
    format!("{{{}}}", parts.join(","))
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

/// Postgres' `boolin`: surrounding whitespace ignored, then any prefix of
/// `true`, `false`, `yes` or `no`, `on`, `off` (at least `of`), `1` or `0`,
/// in any case.
pub(crate) fn pg_bool(text: &str) -> Option<bool> {
    let text = text
        .trim_matches(|c: char| matches!(c, ' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r'))
        .to_ascii_lowercase();
    let prefix_of = |word: &str| !text.is_empty() && word.starts_with(text.as_str());
    match text.as_bytes().first()? {
        b't' if prefix_of("true") => Some(true),
        b'f' if prefix_of("false") => Some(false),
        b'y' if prefix_of("yes") => Some(true),
        b'n' if prefix_of("no") => Some(false),
        b'o' if text == "on" => Some(true),
        b'o' if text.len() >= 2 && "off".starts_with(text.as_str()) => Some(false),
        b'1' if text.len() == 1 => Some(true),
        b'0' if text.len() == 1 => Some(false),
        _ => None,
    }
}

/// `Number.parseInt(text, 10)`: leading whitespace, a sign, then as many
/// digits as there are; `NaN` without any.
pub(crate) fn parse_int(text: &str) -> f64 {
    let text = weldsuite_kit::validation::js_trim(text);
    let (negative, rest) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    let value: f64 = digits.parse().unwrap_or(f64::INFINITY);
    if negative { -value } else { value }
}

/// `Math.min(a, b)` with JavaScript's `NaN`.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `Math.max(a, b)` with JavaScript's `NaN`.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// The page-size argument of Drizzle's `.limit(n)`: no `LIMIT` at all for
/// `NaN` or a negative number (bound as `null`, which is `LIMIT ALL`).
pub(crate) fn sql_limit(n: f64) -> Option<i64> {
    // `n >= 0` is false for NaN. A count past i64 is "everything".
    #[allow(clippy::cast_possible_truncation)]
    let whole = if n >= 9.2e18 { i64::MAX } else { n as i64 };
    (n >= 0.0).then_some(whole)
}

/// `rows.slice(0, end)` of a page of `len` rows: a negative `end` counts from
/// the back; `NaN` is 0.
pub(crate) fn slice_end(len: usize, end: f64) -> usize {
    if end.is_nan() {
        return 0;
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    let magnitude = end.abs().min(usize::MAX as f64) as usize;
    if end < 0.0 {
        len.saturating_sub(magnitude)
    } else {
        len.min(magnitude)
    }
}

/// The first value of a query parameter, as `c.req.query()` keeps it.
pub(crate) fn query_first(query: &Map<String, Value>, key: &str) -> Option<String> {
    match query.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(items)) => items.first().and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const COLUMNS: [Column; 5] = [
        col("title", "title", Kind::Text(Some(5)), true),
        col("isRead", "is_read", Kind::Bool, true),
        col("data", "data", Kind::Json, false),
        col("readAt", "read_at", Kind::Timestamp, false),
        col("body", "body", Kind::Text(None), false),
    ];

    fn values(body: Value) -> Result<Value, String> {
        let Value::Object(body) = body else {
            unreachable!()
        };
        column_values(&COLUMNS, &body)
            .map(Value::Object)
            .map_err(|e| e.0)
    }

    #[test]
    fn column_keys_reach_the_sql_typed_as_the_driver_sends_them() {
        assert_eq!(
            values(json!({ "title": 12, "isRead": "Yes", "data": "x", "other": 1 })),
            Ok(json!({ "title": "12", "is_read": true, "data": "x" }))
        );
        assert_eq!(
            values(json!({ "body": [1, "a\"b", null, [true]], "readAt": null })),
            Ok(json!({ "body": "{\"1\",\"a\\\"b\",NULL,{\"true\"}}", "read_at": null }))
        );
        assert_eq!(
            values(json!({ "title": "abc     " })),
            Ok(json!({ "title": "abc     " }))
        );
    }

    #[test]
    fn what_the_database_refuses_is_unwritable() {
        assert!(values(json!({ "title": null })).is_err());
        assert!(values(json!({ "title": "abcdef" })).is_err());
        assert!(values(json!({ "readAt": "2026-01-01T00:00:00Z" })).is_err());
        assert!(values(json!({ "isRead": "maybe" })).is_err());
        assert!(values(json!({ "body": "a\u{0}b" })).is_err());
        assert!(values(json!({ "data": { "k": "a\u{0}" } })).is_err());
    }

    #[test]
    fn booleans_read_as_postgres_reads_them() {
        for (text, flag) in [
            ("t", Some(true)),
            (" TRUE ", Some(true)),
            ("tru", Some(true)),
            ("y", Some(true)),
            ("on", Some(true)),
            ("1", Some(true)),
            ("f", Some(false)),
            ("no", Some(false)),
            ("of", Some(false)),
            ("off", Some(false)),
            ("0", Some(false)),
            ("o", None),
            ("offf", None),
            ("truer", None),
            ("10", None),
            ("", None),
        ] {
            assert_eq!(pg_bool(text), flag, "{text:?}");
        }
    }

    #[test]
    fn numbers_and_pages_follow_javascript() {
        assert_eq!(number_text(1.0), "1");
        assert_eq!(number_text(1.5), "1.5");
        assert_eq!(number_text(1e21), "1e+21");
        assert!(parse_int("abc").is_nan());
        assert!((parse_int(" 12abc") - 12.0).abs() < f64::EPSILON);
        assert!((parse_int("-3") + 3.0).abs() < f64::EPSILON);
        assert_eq!(sql_limit(f64::NAN), None);
        assert_eq!(sql_limit(-1.0), None);
        assert_eq!(sql_limit(0.0), Some(0));
        assert_eq!(slice_end(5, -2.0), 3);
        assert_eq!(slice_end(5, 2.0), 2);
        assert_eq!(slice_end(1, -4.0), 0);
        assert!(js_min(f64::NAN, 100.0).is_nan());
        assert!(js_max(f64::NAN, 1.0).is_nan());
    }
}
