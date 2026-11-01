//! (Copied from `weldsuite-core-objects`: module crates do not depend on each
//! other.) JSON as JavaScript sees it, where the routes can tell: the key order of
//! objects (`JSON.stringify` compares by it), how numbers print, `String(x)`
//! and `asText(x)` (`@weldsuite/text`).
//!
//! `serde_json` keeps object keys sorted, which loses two orders the routes
//! depend on: a request body's (what `JSON.parse` built) and a `jsonb`
//! column's (shorter keys first, then bytewise, which is how Drizzle hands
//! the object back). [`Js`] keeps either.

use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value, json};

pub(crate) use weldsuite_flow_domain::js::{js_date, number_text};

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
    /// A `jsonb` value as Drizzle returns it: keys in `jsonb`'s order.
    pub(crate) fn from_jsonb(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(flag) => Self::Bool(*flag),
            Value::Number(number) => Self::Number(number.as_f64().unwrap_or(f64::NAN)),
            Value::String(text) => Self::String(text.clone()),
            Value::Array(items) => Self::Array(items.iter().map(Self::from_jsonb).collect()),
            Value::Object(map) => {
                let mut entries: Vec<(String, Self)> = map
                    .iter()
                    .map(|(key, value)| (key.clone(), Self::from_jsonb(value)))
                    .collect();
                entries.sort_by(|(a, _), (b, _)| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
                Self::Object(js_key_order(entries))
            }
        }
    }

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
    #[allow(dead_code)]
    pub(crate) fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// `''`, `null` or absent: what the custom field code calls empty.
    pub(crate) fn is_empty_value(value: Option<&Self>) -> bool {
        match value {
            None | Some(Self::Null) => true,
            Some(Self::String(text)) => text.is_empty(),
            Some(_) => false,
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

/// `jsonb` keeps `2.0` as written; JavaScript reads it as `2`. Whole floats
/// become integers, recursively, before a value is written to `jsonb`.
pub(crate) fn whole_numbers(value: &Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => {
            number_value(number.as_f64().unwrap_or(f64::NAN))
        }
        Value::Array(items) => Value::Array(items.iter().map(whole_numbers).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), whole_numbers(value)))
                .collect(),
        ),
        other => other.clone(),
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

/// The request body in JavaScript's key order; `Js::Null` when it isn't
/// JSON (the validator has refused it by then).
#[allow(dead_code)]
pub(crate) fn parse_body(body: &[u8]) -> Js {
    serde_json::from_slice(body).unwrap_or(Js::Null)
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

/// `String(value)`.
pub(crate) fn js_string(value: &Js) -> String {
    match value {
        Js::Null => "null".to_owned(),
        Js::Bool(flag) => flag.to_string(),
        Js::Number(number) => number_text(*number),
        Js::String(text) => text.clone(),
        // `Array.prototype.join`: null items are empty.
        Js::Array(items) => items
            .iter()
            .map(|item| match item {
                Js::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Js::Object(_) => "[object Object]".to_owned(),
    }
}

/// `asText(value)` (`@weldsuite/text`): strings as they are, arrays joined
/// with commas, objects as JSON.
pub(crate) fn as_text(value: &Js) -> String {
    match value {
        Js::Array(items) => items
            .iter()
            .map(|item| match item {
                Js::Null => String::new(),
                other => as_text(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Js::Object(_) => stringify(value),
        other => js_string(other),
    }
}
