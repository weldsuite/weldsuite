//! Rows as the TypeScript routes return them. Drizzle hands a route a row with
//! camelCase keys (the schema's property names), `Date`s for timestamps
//! (`toISOString()` in the JSON: UTC, milliseconds, `Z`) and parsed `jsonb`.
//!
//! The Rust routes select `to_jsonb(t)` and pass it through [`js_row`], which
//! gives the same JSON without a struct per table. It relies on the schema's
//! convention that a property is its column name in camelCase; a table that
//! breaks it needs its own mapping, which the conformance diff points out.

use serde_json::{Map, Value};

/// `created_at` → `createdAt`.
pub fn camel_case(column: &str) -> String {
    let mut out = String::with_capacity(column.len());
    let mut upper = false;
    for c in column.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// A Postgres timestamp as `to_jsonb` writes it, as `Date#toISOString()`
/// would: `2026-10-29T07:00:00.123456+00:00` → `2026-10-29T07:00:00.123Z`.
/// An offset is applied (`07:46:43.102+01:00` → `06:46:43.102Z`); a value
/// without one (`timestamp` without time zone) is UTC, as Drizzle reads it.
/// `None` when the text is not a timestamp.
pub fn js_timestamp(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let digit = |i: usize| bytes.get(i).is_some_and(u8::is_ascii_digit);
    let shape = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
        .iter()
        .all(|&i| digit(i))
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':');
    if !shape {
        return None;
    }
    let (date_time, rest) = text.split_at(19);
    let (fraction, offset) = match rest.strip_prefix('.') {
        Some(after) => {
            let end = after
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(after.len());
            (&after[..end], &after[end..])
        }
        None => ("", rest),
    };
    let millis: String = fraction.chars().chain("000".chars()).take(3).collect();
    let local = format!("{date_time}.{millis}");
    // Postgres writes timestamptz in the session's time zone: shift to UTC.
    let offset_minutes = parse_offset(offset)?;
    if offset_minutes == 0 {
        return Some(format!("{local}Z"));
    }
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]"
    );
    let parsed = time::PrimitiveDateTime::parse(&local, format).ok()?;
    let utc = parsed.assume_utc() - time::Duration::minutes(i64::from(offset_minutes));
    Some(format!("{}Z", utc.format(format).ok()?))
}

/// `""`, `Z`, `+01`, `+01:00`, `-05:30` → minutes east of UTC.
fn parse_offset(offset: &str) -> Option<i32> {
    if offset.is_empty() || offset == "Z" {
        return Some(0);
    }
    let (sign, rest) = match offset.as_bytes().first()? {
        b'+' => (1, &offset[1..]),
        b'-' => (-1, &offset[1..]),
        _ => return None,
    };
    let (hours, minutes) = rest.split_once(':').unwrap_or((rest, "0"));
    if hours.len() != 2
        || !hours
            .bytes()
            .chain(minutes.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some(sign * (hours.parse::<i32>().ok()? * 60 + minutes.parse::<i32>().ok()?))
}

/// A `to_jsonb(row)` value as Drizzle returns the row: camelCase keys,
/// timestamps as `toISOString()`. Nested JSON (`jsonb` columns) is kept as is.
pub fn js_row(row: Value) -> Value {
    let Value::Object(columns) = row else {
        return row;
    };
    let mut out = Map::with_capacity(columns.len());
    for (column, value) in columns {
        let value = match value {
            Value::String(text) => match js_timestamp(&text) {
                Some(stamp) => Value::String(stamp),
                None => Value::String(text),
            },
            other => other,
        };
        out.insert(camel_case(&column), value);
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn rows_read_like_drizzle_rows() {
        assert_eq!(camel_case("delivered_in_app"), "deliveredInApp");
        assert_eq!(camel_case("id"), "id");
        assert_eq!(
            js_timestamp("2026-10-29T07:00:00.123456+00:00").as_deref(),
            Some("2026-10-29T07:00:00.123Z")
        );
        assert_eq!(
            js_timestamp("2026-10-29T07:00:00+00:00").as_deref(),
            Some("2026-10-29T07:00:00.000Z")
        );
        assert_eq!(
            js_timestamp("2026-10-29T07:00:00.5").as_deref(),
            Some("2026-10-29T07:00:00.500Z")
        );
        assert_eq!(js_timestamp("2026-10-29"), None);
        assert_eq!(
            js_timestamp("2026-10-29T07:46:43.102+01:00").as_deref(),
            Some("2026-10-29T06:46:43.102Z")
        );
        assert_eq!(
            js_timestamp("2026-01-01T00:30:00-05:30").as_deref(),
            Some("2026-01-01T06:00:00.000Z")
        );
        assert_eq!(
            js_timestamp("2026-10-29T00:10:00+01").as_deref(),
            Some("2026-10-28T23:10:00.000Z")
        );
        assert_eq!(js_timestamp("2026-10-29T07:00:00 nope"), None);
        assert_eq!(
            js_row(json!({
                "user_id": "u", "read_at": null, "data": { "page_label": "x" },
                "created_at": "2026-10-29T07:00:00.1+00:00", "title": "Access request"
            })),
            json!({
                "userId": "u", "readAt": null, "data": { "page_label": "x" },
                "createdAt": "2026-10-29T07:00:00.100Z", "title": "Access request"
            })
        );
    }
}
