//! JavaScript's printing of values, where the tool results are text: `String(x)`,
//! `asText` (`@weldsuite/text`), `JSON.stringify` (compact and indented), and
//! the key order JavaScript would have kept. Rust's JSON objects come back
//! sorted; JavaScript's keep insertion order, which for a Drizzle row is the
//! table's column order and for a `jsonb` value `jsonb`'s own (shorter keys
//! first, then bytewise).

use serde_json::{Map, Number, Value};

use crate::catalog::catalog;

/// `String(n)` for a JSON number.
pub(crate) fn number_text(number: &Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }
    let Some(value) = number.as_f64() else {
        return number.to_string();
    };
    float_text(value)
}

/// `String(n)` for a double: integral values without a fraction, the shortest
/// round-trip digits otherwise, exponents as JavaScript writes them.
pub(crate) fn float_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if (1e-6..1e21).contains(&magnitude) {
        if value.fract() == 0.0 {
            return format!("{value:.0}");
        }
        return format!("{value}");
    }
    // `1e21` → `1e+21`, `1e-7` stays.
    let text = format!("{value:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// `String(value)` as `URLSearchParams.set` and template literals print it.
pub(crate) fn string_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number_text(number),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_owned(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    string_of(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `asText(value)` (`@weldsuite/text`).
pub(crate) fn as_text(value: &Value) -> String {
    match value {
        Value::Object(_) => stringify(value, Order::Jsonb),
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
        other => string_of(other),
    }
}

/// Which key order an object prints in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Order {
    /// A value read from a `jsonb` column.
    Jsonb,
    /// A table's row at the top, `jsonb` below it.
    Row,
    /// An answer's envelope (`data`, `pagination`, then the rest), rows
    /// inside it.
    Envelope,
}

/// `jsonb`'s key order: shorter keys first, then bytewise.
pub(crate) fn jsonb_keys(object: &Map<String, Value>) -> Vec<&String> {
    let mut keys: Vec<&String> = object.keys().collect();
    keys.sort_by(|a, b| {
        a.len()
            .cmp(&b.len())
            .then_with(|| a.as_bytes().cmp(b.as_bytes()))
    });
    keys
}

/// A row's keys in the order of the table it most likely is: the smallest
/// table holding every key, else the one holding the most; keys the table
/// does not have follow, bytewise.
pub(crate) fn row_keys(object: &Map<String, Value>) -> Vec<&String> {
    let tables = &catalog().tables;
    let overlap = |columns: &Vec<String>| object.keys().filter(|key| columns.contains(key)).count();
    let best = tables
        .iter()
        .filter(|columns| object.keys().all(|key| columns.contains(key)))
        .min_by_key(|columns| columns.len())
        .or_else(|| {
            tables
                .iter()
                .filter(|columns| overlap(columns) > 0)
                .max_by(|a, b| {
                    overlap(a)
                        .cmp(&overlap(b))
                        .then_with(|| b.len().cmp(&a.len()))
                })
        });
    let Some(columns) = best else {
        return object.keys().collect();
    };
    let mut keys: Vec<&String> = columns
        .iter()
        .filter_map(|column| object.get_key_value(column).map(|(key, _)| key))
        .collect();
    for key in object.keys() {
        if !columns.contains(key) {
            keys.push(key);
        }
    }
    keys
}

fn envelope_keys(object: &Map<String, Value>) -> Vec<&String> {
    let mut keys: Vec<&String> = Vec::with_capacity(object.len());
    for first in ["data", "pagination"] {
        if let Some((key, _)) = object.get_key_value(first) {
            keys.push(key);
        }
    }
    for key in object.keys() {
        if key != "data" && key != "pagination" {
            keys.push(key);
        }
    }
    keys
}

/// The keys of `object` in the order `order` gives, and the order of the
/// values below it.
pub(crate) fn ordered(object: &Map<String, Value>, order: Order) -> (Vec<&String>, Order) {
    match order {
        Order::Jsonb => (jsonb_keys(object), Order::Jsonb),
        Order::Row => (row_keys(object), Order::Jsonb),
        Order::Envelope => (envelope_keys(object), Order::Row),
    }
}

fn quote(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

fn write(value: &Value, order: Order, indent: Option<&str>, depth: usize, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number_text(number)),
        Value::String(text) => out.push_str(&quote(text)),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(indent, depth + 1, out);
                // Rows inside an envelope's list keep the row order.
                write(
                    item,
                    if order == Order::Row {
                        Order::Row
                    } else {
                        order
                    },
                    indent,
                    depth + 1,
                    out,
                );
            }
            newline(indent, depth, out);
            out.push(']');
        }
        Value::Object(object) => {
            if object.is_empty() {
                out.push_str("{}");
                return;
            }
            let (keys, inner) = ordered(object, order);
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(indent, depth + 1, out);
                out.push_str(&quote(key));
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write(&object[*key], inner, indent, depth + 1, out);
            }
            newline(indent, depth, out);
            out.push('}');
        }
    }
}

fn newline(indent: Option<&str>, depth: usize, out: &mut String) {
    if let Some(indent) = indent {
        out.push('\n');
        for _ in 0..depth {
            out.push_str(indent);
        }
    }
}

/// `JSON.stringify(value)`.
pub(crate) fn stringify(value: &Value, order: Order) -> String {
    let mut out = String::new();
    write(value, order, None, 0, &mut out);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub(crate) fn stringify_pretty(value: &Value, order: Order) -> String {
    let mut out = String::new();
    write(value, order, Some("  "), 0, &mut out);
    out
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    weldsuite_kit::cursor::encode_uri_component(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_as_javascript_does() {
        assert_eq!(float_text(1.0), "1");
        assert_eq!(float_text(1.5), "1.5");
        assert_eq!(float_text(1e21), "1e+21");
        assert_eq!(string_of(&json!([1, null, "a"])), "1,,a");
        assert_eq!(string_of(&json!({ "a": 1 })), "[object Object]");
    }

    #[test]
    fn jsonb_orders_shorter_keys_first() {
        let value = json!({ "bb": 1, "a": { "zz": 1, "y": 2 }, "ccc": [] });
        assert_eq!(
            stringify(&value, Order::Jsonb),
            r#"{"a":{"y":2,"zz":1},"bb":1,"ccc":[]}"#
        );
        assert_eq!(
            stringify_pretty(&json!({ "data": { "success": true } }), Order::Envelope),
            "{\n  \"data\": {\n    \"success\": true\n  }\n}"
        );
    }
}
