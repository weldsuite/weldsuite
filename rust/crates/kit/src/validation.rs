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

/// How a field may be left out: Zod's `.optional()`, `.nullable()` and
/// `.nullish()`, or none of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Required,
    Optional,
    Nullable,
    Nullish,
}

/// A field as the schema read it. An invalid field reads as `Absent`; the
/// issue makes [`Issues::finish`] fail.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Field<T> {
    /// Left out (`undefined`).
    #[default]
    Absent,
    /// `null`.
    Null,
    Set(T),
}

impl<T> Field<T> {
    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }

    /// The value, if there is one.
    pub fn as_set(&self) -> Option<&T> {
        match self {
            Self::Set(value) => Some(value),
            _ => None,
        }
    }

    /// `value ?? null`: absent and null both read as `None`.
    pub fn into_option(self) -> Option<T> {
        match self {
            Self::Set(value) => Some(value),
            _ => None,
        }
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

    fn push_at(&mut self, path: &Value, expected: &str, value: &Value) {
        let received = parsed_type(Some(value));
        self.0.push(json!({
            "code": "invalid_type",
            "expected": expected,
            "received": received,
            "path": path,
            "message": format!("Expected {expected}, received {received}"),
        }));
    }

    /// Absent or null, as `presence` allows: the field read so far. `None`
    /// when there is a value to check.
    fn left_out<T>(
        &mut self,
        key: &str,
        expected: &str,
        value: Option<&Value>,
        presence: Presence,
    ) -> Option<Field<T>> {
        match value {
            None => {
                if matches!(presence, Presence::Required | Presence::Nullable) {
                    self.invalid_type(key, expected, None);
                }
                Some(Field::Absent)
            }
            Some(Value::Null) if matches!(presence, Presence::Nullable | Presence::Nullish) => {
                Some(Field::Null)
            }
            Some(Value::Null) => {
                self.invalid_type(key, expected, value);
                Some(Field::Absent)
            }
            Some(_) => None,
        }
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
        let presence = if required {
            Presence::Required
        } else {
            Presence::Optional
        };
        self.text(body, key, presence, min, max).into_option()
    }

    /// `z.string().min(min).max(max)` with `presence`.
    pub fn text(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        min: Option<usize>,
        max: Option<usize>,
    ) -> Field<String> {
        let value = body.get(key);
        if let Some(field) = self.left_out(key, "string", value, presence) {
            return field;
        }
        let Some(Value::String(text)) = value else {
            self.invalid_type(key, "string", value);
            return Field::Absent;
        };
        // Zod counts UTF-16 code units, as JavaScript's `length` does.
        let length = text.encode_utf16().count();
        let before = self.0.len();
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
        if self.0.len() > before {
            return Field::Absent;
        }
        Field::Set(text.clone())
    }

    /// `z.boolean()` with `presence`.
    pub fn boolean(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
    ) -> Field<bool> {
        let value = body.get(key);
        if let Some(field) = self.left_out(key, "boolean", value, presence) {
            return field;
        }
        if let Some(Value::Bool(flag)) = value {
            return Field::Set(*flag);
        }
        self.invalid_type(key, "boolean", value);
        Field::Absent
    }

    /// `z.number().int()`, `.min(min)` when given, with `presence`.
    pub fn integer(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        min: Option<i64>,
    ) -> Field<i64> {
        let value = body.get(key);
        if let Some(field) = self.left_out(key, "number", value, presence) {
            return field;
        }
        let Some(Value::Number(number)) = value else {
            self.invalid_type(key, "number", value);
            return Field::Absent;
        };
        let float = number.as_f64().unwrap_or(f64::NAN);
        let before = self.0.len();
        // `1.0` is an integer to JavaScript.
        #[allow(clippy::cast_possible_truncation)]
        let integer = number
            .as_i64()
            .or_else(|| (float.fract() == 0.0 && float.abs() < 9.0e15).then_some(float as i64));
        if integer.is_none() {
            self.0.push(json!({
                "code": "invalid_type",
                "expected": "integer",
                "received": "float",
                "message": "Expected integer, received float",
                "path": path(key),
            }));
        }
        #[allow(clippy::cast_precision_loss)]
        if let Some(min) = min
            && float < min as f64
        {
            self.0.push(json!({
                "code": "too_small",
                "minimum": min,
                "type": "number",
                "inclusive": true,
                "exact": false,
                "message": format!("Number must be greater than or equal to {min}"),
                "path": path(key),
            }));
        }
        match integer {
            Some(integer) if self.0.len() == before => Field::Set(integer),
            _ => Field::Absent,
        }
    }

    /// `z.array(z.record(z.unknown()))` with `presence`: a list of objects.
    pub fn records(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
    ) -> Field<Vec<Value>> {
        let value = body.get(key);
        if let Some(field) = self.left_out(key, "array", value, presence) {
            return field;
        }
        let Some(Value::Array(items)) = value else {
            self.invalid_type(key, "array", value);
            return Field::Absent;
        };
        let before = self.0.len();
        for (index, item) in items.iter().enumerate() {
            if !item.is_object() {
                self.push_at(&json!([key, index]), "object", item);
            }
        }
        if self.0.len() > before {
            return Field::Absent;
        }
        Field::Set(items.clone())
    }

    /// `z.enum([...])` with `presence`.
    pub fn choice(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        options: &[&str],
    ) -> Field<String> {
        let expected = options
            .iter()
            .map(|o| format!("'{o}'"))
            .collect::<Vec<_>>()
            .join(" | ");
        let value = body.get(key);
        if let Some(field) = self.left_out(key, &expected, value, presence) {
            return field;
        }
        match value {
            Some(Value::String(text)) if options.contains(&text.as_str()) => {
                Field::Set(text.clone())
            }
            Some(Value::String(text)) => {
                self.0.push(json!({
                    "received": text,
                    "code": "invalid_enum_value",
                    "options": options,
                    "path": path(key),
                    "message": format!("Invalid enum value. Expected {expected}, received '{text}'"),
                }));
                Field::Absent
            }
            _ => {
                self.invalid_type(key, &expected, value);
                Field::Absent
            }
        }
    }

    /// `z.enum([...])`, required.
    pub fn one_of(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        options: &[&str],
    ) -> Option<String> {
        self.choice(body, key, Presence::Required, options)
            .into_option()
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

    /// Zod 3's issues for the rules the know schemas use (run against `zod`
    /// in core-api-client; the same issues, key order aside).
    #[test]
    fn optional_nullable_numbers_and_records_match_zod() {
        let mut issues = Issues::default();
        let body = json!({});
        let fields = issues_object(&body);
        assert_eq!(
            issues.text(fields, "name", Presence::Optional, Some(1), None),
            Field::Absent
        );
        assert_eq!(
            issues.text(fields, "icon", Presence::Nullish, None, Some(3)),
            Field::Absent
        );
        issues.text(fields, "parentId", Presence::Nullable, None, None);
        assert_eq!(
            Value::Array(issues.0),
            json!([{"code":"invalid_type","expected":"string","received":"undefined","path":["parentId"],"message":"Required"}])
        );

        let mut issues = Issues::default();
        let body = json!({ "description": null, "icon": "abcd", "visibility": "x", "isDefault": "yes",
            "sortOrder": 1.5, "position": -1, "parentId": 3, "contentJson": [{}, 1, null, []] });
        let fields = issues_object(&body);
        issues.text(fields, "description", Presence::Optional, None, None);
        issues.text(fields, "icon", Presence::Nullish, None, Some(3));
        issues.choice(
            fields,
            "visibility",
            Presence::Optional,
            &["open", "closed", "private"],
        );
        issues.boolean(fields, "isDefault", Presence::Optional);
        issues.integer(fields, "sortOrder", Presence::Optional, None);
        issues.integer(fields, "position", Presence::Optional, Some(0));
        issues.text(fields, "parentId", Presence::Nullable, None, None);
        issues.records(fields, "contentJson", Presence::Optional);
        assert_eq!(
            Value::Array(issues.0),
            json!([
                {"code":"invalid_type","expected":"string","received":"null","path":["description"],"message":"Expected string, received null"},
                {"code":"too_big","maximum":3,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 3 character(s)","path":["icon"]},
                {"received":"x","code":"invalid_enum_value","options":["open","closed","private"],"path":["visibility"],"message":"Invalid enum value. Expected 'open' | 'closed' | 'private', received 'x'"},
                {"code":"invalid_type","expected":"boolean","received":"string","path":["isDefault"],"message":"Expected boolean, received string"},
                {"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":["sortOrder"]},
                {"code":"too_small","minimum":0,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 0","path":["position"]},
                {"code":"invalid_type","expected":"string","received":"number","path":["parentId"],"message":"Expected string, received number"},
                {"code":"invalid_type","expected":"object","received":"number","path":["contentJson",1],"message":"Expected object, received number"},
                {"code":"invalid_type","expected":"object","received":"null","path":["contentJson",2],"message":"Expected object, received null"},
                {"code":"invalid_type","expected":"object","received":"array","path":["contentJson",3],"message":"Expected object, received array"}
            ])
        );

        let mut issues = Issues::default();
        let body = json!({ "visibility": 3, "sortOrder": "1", "position": 2.5, "contentJson": {}, "parentId": null });
        let fields = issues_object(&body);
        issues.choice(
            fields,
            "visibility",
            Presence::Optional,
            &["open", "closed", "private"],
        );
        issues.integer(fields, "sortOrder", Presence::Optional, None);
        issues.integer(fields, "position", Presence::Optional, Some(0));
        assert_eq!(
            issues.text(fields, "parentId", Presence::Nullable, None, None),
            Field::Null
        );
        issues.records(fields, "contentJson", Presence::Optional);
        assert_eq!(
            Value::Array(issues.0),
            json!([
                {"expected":"'open' | 'closed' | 'private'","received":"number","code":"invalid_type","path":["visibility"],"message":"Expected 'open' | 'closed' | 'private', received number"},
                {"code":"invalid_type","expected":"number","received":"string","path":["sortOrder"],"message":"Expected number, received string"},
                {"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":["position"]},
                {"code":"invalid_type","expected":"array","received":"object","path":["contentJson"],"message":"Expected array, received object"}
            ])
        );

        let mut issues = Issues::default();
        let body =
            json!({ "position": 3.0, "isLocked": true, "contentJson": [{ "type": "paragraph" }] });
        let fields = issues_object(&body);
        assert_eq!(
            issues.integer(fields, "position", Presence::Optional, Some(0)),
            Field::Set(3)
        );
        assert_eq!(
            issues.boolean(fields, "isLocked", Presence::Optional),
            Field::Set(true)
        );
        assert_eq!(
            issues.records(fields, "contentJson", Presence::Required),
            Field::Set(vec![json!({ "type": "paragraph" })])
        );
        assert!(issues.is_empty());
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
