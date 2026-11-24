//! The carrier calls' plumbing: one send for writes, one retry for reads,
//! query strings, and the JSON shapes both carriers answer with.

use serde_json::Value;
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use crate::error::CarrierError;

/// Send once (a write: a label must not be made twice). A connection
/// failure is [`CarrierError::Unavailable`].
pub(crate) async fn send(
    http: &OutboundHttp,
    request: HttpRequest,
) -> Result<HttpResponse, CarrierError> {
    http.send(request).await.map_err(|error| {
        CarrierError::unavailable(format!("The carrier could not be reached: {error}"))
    })
}

/// Send a read, and once more when it fails to connect or answers 5xx.
pub(crate) async fn send_read(
    http: &OutboundHttp,
    request: HttpRequest,
) -> Result<HttpResponse, CarrierError> {
    match http.send(request.clone()).await {
        Ok(response) if response.status < 500 => Ok(response),
        _ => send(http, request).await,
    }
}

/// `a=1&b=x%20y`, in the order given; empty values left out.
pub(crate) fn query(pairs: &[(&str, &str)]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        if !value.is_empty() {
            serializer.append_pair(key, value);
        }
    }
    serializer.finish()
}

/// A JSON value as a list: an array as it is, one object as a list of one,
/// nothing (`null`, `{}`) as empty. PostNL answers a single event as an
/// object and an empty field as `{}`.
pub(crate) fn list(value: Option<&Value>) -> Vec<&Value> {
    match value {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(Value::Object(map)) if map.is_empty() => Vec::new(),
        Some(object @ Value::Object(_)) => vec![object],
        _ => Vec::new(),
    }
}

/// A field as text: strings as they are, numbers written out, `{}` and
/// `null` as nothing.
pub(crate) fn text(value: &Value, key: &str) -> Option<String> {
    match value.get(key)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// `{ "message": … }`-style errors, as text, for an unexpected answer.
pub(crate) fn body_excerpt(response: &HttpResponse) -> String {
    let text = response.text();
    let trimmed = text.trim();
    if trimmed.chars().count() > 300 {
        let cut: String = trimmed.chars().take(300).collect();
        format!("{cut}…")
    } else {
        trimmed.to_owned()
    }
}

/// Cents as a decimal amount with two places (`11999` → `119.99`).
#[allow(clippy::cast_precision_loss)]
pub(crate) fn amount(cents: u64) -> f64 {
    (cents as f64) / 100.0
}

/// Grams as kilograms with three places (`1500` → `1.5`).
pub(crate) fn kilograms(grams: u32) -> f64 {
    f64::from(grams) / 1000.0
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn lists_read_postnl_shapes() {
        let one = json!({ "Event": { "Code": "A01" } });
        assert_eq!(list(one.get("Event")).len(), 1);
        let many = json!({ "Event": [{ "Code": "A01" }, { "Code": "J01" }] });
        assert_eq!(list(many.get("Event")).len(), 2);
        let empty = json!({ "Event": {} });
        assert_eq!(list(empty.get("Event")), Vec::<&Value>::new());
        assert_eq!(list(None), Vec::<&Value>::new());
    }

    #[test]
    fn query_strings_leave_out_empty_values() {
        assert_eq!(
            query(&[
                ("CountryCode", "NL"),
                ("PostalCode", "1012 AB"),
                ("City", "")
            ]),
            "CountryCode=NL&PostalCode=1012+AB"
        );
    }

    #[test]
    fn units() {
        assert!((amount(11_999) - 119.99).abs() < 1e-9);
        assert!((kilograms(1500) - 1.5).abs() < 1e-9);
        assert_eq!(
            text(&json!({ "a": 163_043 }), "a").as_deref(),
            Some("163043")
        );
        assert_eq!(text(&json!({ "a": {} }), "a"), None);
    }
}
