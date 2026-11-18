//! The bits of JavaScript string and number semantics the subscribers'
//! TypeScript relies on: `trim()`, `\s`, `String(number)`, `slice()` in
//! UTF-16 units.

use serde_json::Value;

/// JavaScript's `WhiteSpace` and `LineTerminator`: what `trim()` removes and
/// `\s` matches. Unicode `White_Space` without U+0085, plus the BOM.
pub(crate) fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `String.prototype.trim()`.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
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
    let text = format!("{number:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// `String(value)` for a JSON number.
pub(crate) fn json_number_text(number: &serde_json::Number) -> String {
    if let Some(n) = number.as_i64() {
        return n.to_string();
    }
    if let Some(n) = number.as_u64() {
        return n.to_string();
    }
    number_text(number.as_f64().unwrap_or(f64::NAN))
}

/// `String(value)`: `Array.prototype.join` for arrays (null items empty),
/// `[object Object]` for objects.
pub(crate) fn string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => json_number_text(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => join(items, ","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `items.join(separator)`.
pub(crate) fn join(items: &[Value], separator: &str) -> String {
    items
        .iter()
        .map(|item| match item {
            Value::Null => String::new(),
            other => string_of(other),
        })
        .collect::<Vec<_>>()
        .join(separator)
}

/// `asText(value)` (`@weldsuite/text`): `String()` except that a plain
/// object becomes JSON. (`serde_json` writes object keys sorted; `jsonb`,
/// where these values come from, already reordered them.)
pub(crate) fn as_text(value: &Value) -> String {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => as_text(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => value.to_string(),
        other => string_of(other),
    }
}

/// A JSON value as JavaScript holds it after `JSON.parse`: numbers are
/// doubles and an object's keys keep their order (array-index keys first).
/// `serde_json::Value` sorts the keys, which changes what `JSON.stringify`
/// would write.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// `JSON.parse(text)`; `None` when `text` is not JSON.
    pub(crate) fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }

    /// `value[key]` of an object; `None` for a missing key and for anything
    /// that is not an object.
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

    /// `JSON.stringify(value)`.
    pub(crate) fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
            // `JSON.stringify(Infinity)` is `null`.
            Self::Number(number) if !number.is_finite() => out.push_str("null"),
            Self::Number(number) => out.push_str(&number_text(*number)),
            Self::String(text) => out.push_str(&quote(text)),
            Self::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Self::Object(entries) => {
                out.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&quote(key));
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

impl<'de> serde::Deserialize<'de> for Json {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;

        impl<'de> serde::de::Visitor<'de> for JsonVisitor {
            type Value = Json;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON value")
            }

            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }

            fn visit_bool<E>(self, flag: bool) -> Result<Json, E> {
                Ok(Json::Bool(flag))
            }

            // Every JavaScript number is a double: an integer past 2^53
            // loses its last digits there too.
            #[allow(clippy::cast_precision_loss)]
            fn visit_i64<E>(self, number: i64) -> Result<Json, E> {
                Ok(Json::Number(number as f64))
            }

            #[allow(clippy::cast_precision_loss)]
            fn visit_u64<E>(self, number: u64) -> Result<Json, E> {
                Ok(Json::Number(number as f64))
            }

            fn visit_f64<E>(self, number: f64) -> Result<Json, E> {
                Ok(Json::Number(number))
            }

            fn visit_str<E>(self, text: &str) -> Result<Json, E> {
                Ok(Json::String(text.to_owned()))
            }

            fn visit_string<E>(self, text: String) -> Result<Json, E> {
                Ok(Json::String(text))
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<Json>()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut entries: Vec<(String, Json)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    // A repeated key keeps its first position and the last value.
                    if let Some(slot) = entries.iter_mut().find(|(k, _)| *k == key) {
                        slot.1 = value;
                    } else {
                        entries.push((key, value));
                    }
                }
                Ok(Json::Object(crate::event::js_key_order(entries)))
            }
        }

        deserializer.deserialize_any(JsonVisitor)
    }
}

/// `JSON.stringify(text)`: the string quoted and escaped. (`serde_json`
/// escapes what JavaScript escapes: the quote, the backslash and the C0
/// controls, as `\b \t \n \f \r` or `\u00xx`.)
pub(crate) fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned())
}

/// A string as UTF-16 units, the way JavaScript indexes it.
pub(crate) fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// UTF-16 units back to a string. A surrogate cut in half becomes U+FFFD,
/// as `TextEncoder` and the Postgres driver turn it.
pub(crate) fn from_units(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `text.length`.
#[cfg(test)]
pub(crate) fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, max)`.
pub(crate) fn slice_to(text: &str, max: usize) -> String {
    let units = units(text);
    if units.len() <= max {
        return text.to_owned();
    }
    from_units(&units[..max])
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn trim_is_javascripts() {
        assert_eq!(trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn numbers_print_as_in_javascript() {
        assert_eq!(number_text(1001.0), "1001");
        assert_eq!(number_text(12.5), "12.5");
        assert_eq!(number_text(1e21), "1e+21");
        assert_eq!(number_text(1.5e-7), "1.5e-7");
        assert_eq!(string_of(&json!([1, null, "a", [2, 3]])), "1,,a,2,3");
        assert_eq!(as_text(&json!({ "a": 1 })), "{\"a\":1}");
    }

    #[test]
    fn slices_count_utf16_units() {
        assert_eq!(slice_to("héllo", 2), "hé");
        assert_eq!(slice_to("a😀b", 2), "a\u{fffd}");
        assert_eq!(length("a😀b"), 4);
    }
}
