//! JSON as JavaScript holds it, for the provider responses the routes read
//! by key order or print: `Object.keys` of a parsed object (array-index keys
//! first, then first-seen order), `JSON.stringify` and `String(x)`.
//! `serde_json`'s map sorts keys, which loses both.

use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

/// A parsed JSON value with JavaScript's object key order.
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
    /// `JSON.parse(text)`; `None` where it throws.
    pub(crate) fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }

    /// `value[key]` on an object; `None` is `undefined`.
    pub(crate) fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// JavaScript truthiness.
    pub(crate) fn truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(flag) => *flag,
            Self::Number(number) => *number != 0.0 && !number.is_nan(),
            Self::String(text) => !text.is_empty(),
            Self::Array(_) | Self::Object(_) => true,
        }
    }

    /// `Object.keys(value)` (strings and arrays list their indexes).
    pub(crate) fn keys(&self) -> Vec<String> {
        match self {
            Self::Object(entries) => entries.iter().map(|(k, _)| k.clone()).collect(),
            Self::Array(items) => (0..items.len()).map(|i| i.to_string()).collect(),
            Self::String(text) => (0..crate::js::utf16_len(text))
                .map(|i| i.to_string())
                .collect(),
            _ => Vec::new(),
        }
    }

    /// `String(value)`.
    pub(crate) fn to_js_string(&self) -> String {
        match self {
            Self::Null => "null".to_owned(),
            Self::Bool(flag) => flag.to_string(),
            Self::Number(number) => number_text(*number),
            Self::String(text) => text.clone(),
            Self::Array(items) => items
                .iter()
                .map(|item| match item {
                    Self::Null => String::new(),
                    other => other.to_js_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
            Self::Object(_) => "[object Object]".to_owned(),
        }
    }

    /// `JSON.stringify(value)`.
    pub(crate) fn stringify(&self) -> String {
        match self {
            Self::Null => "null".to_owned(),
            Self::Bool(flag) => flag.to_string(),
            Self::Number(number) if number.is_finite() => number_text(*number),
            Self::Number(_) => "null".to_owned(),
            Self::String(text) => serde_json::Value::String(text.clone()).to_string(),
            Self::Array(items) => format!(
                "[{}]",
                items.iter().map(Self::stringify).collect::<Vec<_>>().join(",")
            ),
            Self::Object(entries) => format!(
                "{{{}}}",
                entries
                    .iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::Value::String(key.clone()),
                        value.stringify()
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }

    /// The `serde_json` value (key order is lost).
    pub(crate) fn to_value(&self) -> serde_json::Value {
        match self {
            Self::Null => serde_json::Value::Null,
            Self::Bool(flag) => serde_json::Value::Bool(*flag),
            Self::Number(number) => number_value(*number),
            Self::String(text) => serde_json::Value::String(text.clone()),
            Self::Array(items) => {
                serde_json::Value::Array(items.iter().map(Self::to_value).collect())
            }
            Self::Object(entries) => serde_json::Value::Object(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), value.to_value()))
                    .collect(),
            ),
        }
    }
}

/// A number as JSON: whole numbers as integers, non-finite as `null`.
pub(crate) fn number_value(number: f64) -> serde_json::Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        serde_json::Value::from(number as i64)
    } else if number.is_finite() {
        serde_json::Value::from(number)
    } else {
        serde_json::Value::Null
    }
}

/// `String(number)`.
pub(crate) fn number_text(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number.is_infinite() {
        return if number > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    let abs = number.abs();
    if (1e-6..1e21).contains(&abs) {
        return format!("{number}");
    }
    let text = format!("{number:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// An array index key (`"0"`, `"17"`, below 2^32 - 1): listed first.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// A repeated key keeps its first place with the last value; array-index
/// keys come first, in numeric order.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_javascripts_order_and_printing() {
        let parsed = Js::parse(r#"{"b":1,"a":[1,2.5,null],"2":true,"1":"x","b":3}"#).expect("JSON");
        assert_eq!(parsed.keys(), ["1", "2", "b", "a"]);
        assert_eq!(parsed.stringify(), r#"{"1":"x","2":true,"b":3,"a":[1,2.5,null]}"#);
        assert_eq!(Js::Array(vec![Js::Null, Js::Number(1.0)]).to_js_string(), ",1");
        assert_eq!(Js::Object(Vec::new()).to_js_string(), "[object Object]");
        assert!(!Js::String(String::new()).truthy());
    }
}
