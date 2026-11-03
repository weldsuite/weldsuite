//! JSON as JavaScript holds it, where the collector can tell: a request
//! body's key order (`JSON.parse` keeps it, and the `properties` column is
//! `JSON.stringify` of the event's `props`), and how numbers print.
//! `serde_json` sorts keys, so [`Js`] keeps them.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stringify_keeps_the_body_order_and_prints_numbers_as_javascript() {
        let parsed: Js =
            serde_json::from_str(r#"{"plan":"pro","seats":3,"n":1e308,"x":1.50,"neg":-0}"#)
                .expect("json");
        assert_eq!(
            stringify(&parsed),
            r#"{"plan":"pro","seats":3,"n":1e+308,"x":1.5,"neg":0}"#
        );
    }
}
