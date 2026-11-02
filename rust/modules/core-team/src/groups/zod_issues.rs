//! Zod issues the shared validator (`weldsuite_kit::validation`) has no rule
//! for yet: custom messages on string checks, `.regex()` and `.refine()`,
//! `z.literal()`, `z.union()`, `z.record()` and `.strict()` objects. Each
//! helper pushes the issue Zod 3 writes, field by field in schema order, and
//! [`ZodIssues::finish`] answers like `zValidator` (400 with the
//! `safeParse` result).
//!
//! Zod's two failure levels matter for refinements: a wrong type aborts the
//! object (a `.superRefine()` on it does not run), a failed check only makes
//! it dirty (the refinement still runs). [`ZodIssues::aborted`] tracks the
//! first kind.

use axum::Json;
use axum::response::IntoResponse;
use http::StatusCode;
use serde_json::{Map, Value, json};

use crate::TeamError;

/// Zod's name for a JSON value's type (`getParsedType`).
pub(crate) fn parsed_type(value: Option<&Value>) -> &'static str {
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

/// `String.prototype.trim()`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// JavaScript's `length`: UTF-16 code units.
pub(crate) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The issues of one body, in the order Zod reports them.
#[derive(Debug, Default)]
pub(crate) struct ZodIssues {
    issues: Vec<Value>,
    /// A wrong type somewhere: an object refinement does not run.
    pub(crate) aborted: bool,
}

impl ZodIssues {
    pub(crate) fn push(&mut self, issue: Value) {
        self.issues.push(issue);
    }

    /// `invalid_type` at `path` (aborts the object).
    pub(crate) fn invalid_type(&mut self, path: &Value, expected: &str, value: Option<&Value>) {
        self.issues.push(invalid_type_issue(path, expected, value));
        self.aborted = true;
    }

    /// `too_small` for a string.
    pub(crate) fn too_small(&mut self, path: &Value, minimum: usize, message: &str) {
        self.issues.push(json!({
            "code": "too_small",
            "minimum": minimum,
            "type": "string",
            "inclusive": true,
            "exact": false,
            "message": message,
            "path": path,
        }));
    }

    /// `too_big` for a string.
    pub(crate) fn too_big(&mut self, path: &Value, maximum: usize, message: &str) {
        self.issues.push(json!({
            "code": "too_big",
            "maximum": maximum,
            "type": "string",
            "inclusive": true,
            "exact": false,
            "message": message,
            "path": path,
        }));
    }

    /// `invalid_string` (`.regex()`, `.email()`).
    pub(crate) fn invalid_string(&mut self, path: &Value, validation: &str, message: &str) {
        self.issues.push(json!({
            "validation": validation,
            "code": "invalid_string",
            "message": message,
            "path": path,
        }));
    }

    /// A `.refine()` / `ctx.addIssue` custom issue.
    pub(crate) fn custom(&mut self, path: &Value, message: &str) {
        self.issues
            .push(json!({ "code": "custom", "message": message, "path": path }));
    }

    /// `Err` (the 400) when anything was wrong.
    pub(crate) fn finish(self) -> Result<(), TeamError> {
        if self.issues.is_empty() {
            return Ok(());
        }
        let body =
            json!({ "success": false, "error": { "issues": self.issues, "name": "ZodError" } });
        Err(TeamError::Response(Box::new(
            (StatusCode::BAD_REQUEST, Json(body)).into_response(),
        )))
    }
}

pub(crate) fn invalid_type_issue(path: &Value, expected: &str, value: Option<&Value>) -> Value {
    let received = parsed_type(value);
    let message = if received == "undefined" {
        "Required".to_owned()
    } else {
        format!("Expected {expected}, received {received}")
    };
    json!({
        "code": "invalid_type",
        "expected": expected,
        "received": received,
        "path": path,
        "message": message,
    })
}

/// The body as an object (`z.object(...)`), or the issue at `[]`.
pub(crate) fn object<'a>(
    issues: &mut ZodIssues,
    body: &'a Value,
) -> Option<&'a Map<String, Value>> {
    if let Value::Object(map) = body {
        Some(map)
    } else {
        issues.invalid_type(&json!([]), "object", Some(body));
        None
    }
}

/// `.strict()`: the keys the schema doesn't name (dirty, not aborted).
pub(crate) fn unrecognized_keys(issues: &mut ZodIssues, body: &Map<String, Value>, known: &[&str]) {
    let extra: Vec<&String> = body
        .keys()
        .filter(|k| !known.contains(&k.as_str()))
        .collect();
    if extra.is_empty() {
        return;
    }
    let listed = extra
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(", ");
    issues.push(json!({
        "code": "unrecognized_keys",
        "keys": extra,
        "path": [],
        "message": format!("Unrecognized key(s) in object: {listed}"),
    }));
}
