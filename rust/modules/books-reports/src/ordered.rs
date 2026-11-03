//! JSON whose objects keep their key order, where a client reads the order
//! (`Object.keys(aging)` lists the buckets oldest-last): `serde_json` sorts
//! object keys, JavaScript keeps insertion order.

use axum::response::{IntoResponse, Response};
use http::header::CONTENT_TYPE;
use serde_json::Value;

/// A JSON value with ordered objects.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Json {
    Plain(Value),
    Object(Vec<(String, Json)>),
    Array(Vec<Json>),
}

impl From<Value> for Json {
    fn from(value: Value) -> Self {
        Self::Plain(value)
    }
}

impl Json {
    /// An object from its entries, in order.
    pub(crate) fn object<K: Into<String>>(entries: impl IntoIterator<Item = (K, Json)>) -> Self {
        Self::Object(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    /// Replace (or append) `key` of an object; a plain object becomes ordered
    /// with its existing keys first, sorted.
    pub(crate) fn set(&mut self, key: &str, value: Json) {
        if let Self::Plain(Value::Object(map)) = self {
            let entries = std::mem::take(map)
                .into_iter()
                .map(|(k, v)| (k, Json::Plain(v)))
                .collect();
            *self = Self::Object(entries);
        }
        if let Self::Object(entries) = self {
            if let Some(slot) = entries.iter_mut().find(|(k, _)| k == key) {
                slot.1 = value;
            } else {
                entries.push((key.to_owned(), value));
            }
        }
    }

    fn write(&self, out: &mut String) {
        match self {
            Self::Plain(value) => out.push_str(&value.to_string()),
            Self::Object(entries) => {
                out.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&Value::String(key.clone()).to_string());
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
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
        }
    }

    pub(crate) fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }
}

/// `success(c, data)` with the object order kept.
pub(crate) fn ok(data: &Json) -> Response {
    (
        [(CONTENT_TYPE, "application/json")],
        format!("{{\"data\":{}}}", data.stringify()),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn objects_keep_their_order() {
        let mut data = Json::from(json!({ "b": 1, "a": 2 }));
        data.set(
            "z",
            Json::object([
                ("current", Json::from(json!(1))),
                ("1-30", Json::from(json!(2))),
            ]),
        );
        assert_eq!(
            data.stringify(),
            r#"{"a":2,"b":1,"z":{"current":1,"1-30":2}}"#
        );
    }
}
