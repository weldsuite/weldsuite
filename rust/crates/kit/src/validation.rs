//! Request body validation that answers like `zValidator('json', schema)`
//! (`@hono/zod-validator` 0.4 with Zod 3): a failure is `400` with the
//! `safeParse` result as the body,
//!
//! ```json
//! { "success": false, "error": { "issues": [...], "name": "ZodError" } }
//! ```
//!
//! and each issue carries Zod's own codes, fields and messages. Only the rules
//! the ported routes use are here; add one when a route needs it, with a test
//! against Zod's output.

use axum::Json;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use serde_json::{Map, Value, json};

/// Zod's name for a JSON value's type (`getParsedType`).
fn parsed_type(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// A failed validation: answers 400 with the `safeParse` result.
#[derive(Debug, Clone, PartialEq)]
pub struct Invalid(Vec<Value>);

impl IntoResponse for Invalid {
    fn into_response(self) -> Response {
        let body = json!({ "success": false, "error": { "issues": self.0, "name": "ZodError" } });
        (StatusCode::BAD_REQUEST, Json(body)).into_response()
    }
}

/// Collects issues while a body is read; [`Issues::finish`] turns them into
/// the 400 response.
#[derive(Debug, Default)]
pub struct Issues(Vec<Value>);

impl Issues {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `Err` (a 400 response) when anything was wrong.
    pub fn finish(self) -> Result<(), Invalid> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(Invalid(self.0))
        }
    }

    fn invalid_type(&mut self, key: &str, expected: &str, value: Option<&Value>) {
        let received = parsed_type(value);
        let message = if received == "undefined" {
            "Required".to_owned()
        } else {
            format!("Expected {expected}, received {received}")
        };
        self.0.push(json!({
            "code": "invalid_type",
            "expected": expected,
            "received": received,
            "path": path(key),
            "message": message,
        }));
    }

    /// The body as an object (`z.object(...)`), or an issue at the root.
    pub fn object<'a>(&mut self, body: &'a Value) -> Option<&'a Map<String, Value>> {
        if let Value::Object(map) = body {
            return Some(map);
        }
        let received = parsed_type(Some(body));
        self.0.push(json!({
            "code": "invalid_type",
            "expected": "object",
            "received": received,
            "path": [],
            "message": format!("Expected object, received {received}"),
        }));
        None
    }

    /// `z.string().min(min).max(max)`, `.optional()` when `required` is false.
    pub fn string(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        required: bool,
        min: Option<usize>,
        max: Option<usize>,
    ) -> Option<String> {
        let value = body.get(key);
        let Some(Value::String(text)) = value else {
            if value.is_some() || required {
                self.invalid_type(key, "string", value);
            }
            return None;
        };
        // Zod counts UTF-16 code units, as JavaScript's `length` does.
        let length = text.encode_utf16().count();
        if let Some(min) = min
            && length < min
        {
            self.0.push(json!({
                "code": "too_small",
                "minimum": min,
                "type": "string",
                "inclusive": true,
                "exact": false,
                "message": format!("String must contain at least {min} character(s)"),
                "path": path(key),
            }));
        }
        if let Some(max) = max
            && length > max
        {
            self.0.push(json!({
                "code": "too_big",
                "maximum": max,
                "type": "string",
                "inclusive": true,
                "exact": false,
                "message": format!("String must contain at most {max} character(s)"),
                "path": path(key),
            }));
        }
        Some(text.clone())
    }

    /// `z.enum([...])`, required.
    pub fn one_of(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        options: &[&str],
    ) -> Option<String> {
        let value = body.get(key);
        match value {
            Some(Value::String(text)) if options.contains(&text.as_str()) => Some(text.clone()),
            Some(Value::String(text)) => {
                let expected = options
                    .iter()
                    .map(|o| format!("'{o}'"))
                    .collect::<Vec<_>>()
                    .join(" | ");
                self.0.push(json!({
                    "received": text,
                    "code": "invalid_enum_value",
                    "options": options,
                    "path": path(key),
                    "message": format!("Invalid enum value. Expected {expected}, received '{text}'"),
                }));
                None
            }
            _ => {
                let expected = options
                    .iter()
                    .map(|o| format!("'{o}'"))
                    .collect::<Vec<_>>()
                    .join(" | ");
                self.invalid_type(key, &expected, value);
                None
            }
        }
    }
}

fn path(key: &str) -> Value {
    json!([key])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Issues Zod 3 produced for the same input (`safeParse`, JSON-serialised).
    #[test]
    fn issues_match_zod() {
        let mut issues = Issues::default();
        let body = json!({ "permission": "" });
        let object = issues.object(&body).expect("object");
        issues.string(object, "permission", true, Some(1), Some(100));
        issues.string(object, "pageLabel", false, None, Some(120));
        assert_eq!(
            Value::Array(issues.0),
            json!([{"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["permission"]}])
        );

        let mut issues = Issues::default();
        let body = json!({});
        issues.string(issues_object(&body), "permission", true, None, None);
        assert_eq!(
            Value::Array(issues.0),
            json!([{"code":"invalid_type","expected":"string","received":"undefined","path":["permission"],"message":"Required"}])
        );

        let mut issues = Issues::default();
        let body = json!({ "status": "x" });
        issues.one_of(issues_object(&body), "status", &["approved", "denied"]);
        assert_eq!(
            Value::Array(issues.0),
            json!([{"received":"x","code":"invalid_enum_value","options":["approved","denied"],"path":["status"],"message":"Invalid enum value. Expected 'approved' | 'denied', received 'x'"}])
        );

        let mut issues = Issues::default();
        assert!(issues.object(&json!([1])).is_none());
        assert_eq!(issues.0[0]["message"], "Expected object, received array");
    }

    fn issues_object(body: &Value) -> &Map<String, Value> {
        body.as_object().expect("object")
    }
}

/// A body that says it is JSON but doesn't parse: Hono's validator answers
/// `400` with the text `Malformed JSON in request body`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MalformedJson;

impl IntoResponse for MalformedJson {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, "Malformed JSON in request body").into_response()
    }
}

/// What `zValidator('json', …)` validates: the parsed body when the request's
/// content type is JSON (`application/json`, `application/*+json`), else `{}`,
/// which then fails as missing fields.
pub fn json_body(content_type: Option<&str>, body: &[u8]) -> Result<Value, MalformedJson> {
    let media = content_type
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase());
    let is_json = media.as_deref().is_some_and(|media| {
        media
            .strip_prefix("application/")
            .is_some_and(|subtype| subtype == "json" || subtype.ends_with("+json"))
    });
    if !is_json {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_slice(body).map_err(|_| MalformedJson)
}

#[cfg(test)]
mod body_tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn json_bodies_like_hono() {
        assert_eq!(
            json_body(Some("application/json; charset=utf-8"), b"{\"a\":1}"),
            Ok(json!({ "a": 1 }))
        );
        assert_eq!(
            json_body(Some("application/vnd.api+json"), b"[]"),
            Ok(json!([]))
        );
        assert_eq!(json_body(Some("text/plain"), b"{\"a\":1}"), Ok(json!({})));
        assert_eq!(json_body(None, b""), Ok(json!({})));
        assert_eq!(
            json_body(Some("application/json"), b"{nope"),
            Err(MalformedJson)
        );
    }
}
