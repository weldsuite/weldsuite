//! Request validation as the WeldHR routes answer it.
//!
//! - [`hr_json`]: `hrJson(schema)` (helpers.ts): a failed body answers 400
//!   with the standard error envelope, one readable sentence per issue
//!   (`describeIssue`, de-duplicated, joined with `. `) and the raw Zod
//!   issues in `details`.
//! - [`zod_query`]: a plain `zValidator('query', schema)`: Zod's `safeParse`
//!   result as the body (the payroll routes have their own, `payroll/schema.rs`).

use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use serde_json::{Map, Value, json};
use weldsuite_core_domain::js::number_text;
pub(crate) use weldsuite_kit::validation::query_values;
use weldsuite_kit::validation::{Issues, json_body};

use crate::HrError;

/// The body `zValidator('json')` validates, or Hono's 400 for malformed JSON.
pub(crate) fn body_of(headers: &HeaderMap, body: &Bytes) -> Result<Value, HrError> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    json_body(content_type, body).map_err(|bad| HrError::from(bad.into_response()))
}

/// `hrJson(schema)`: the body read by `read` in the schema's field order, or
/// the readable 400.
pub(crate) fn hr_json<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, HrError> {
    let body = body_of(headers, body)?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    if let Err(invalid) = issues.finish() {
        return Err(readable(invalid.issues()).into());
    }
    value.ok_or_else(|| HrError::internal("hrJson: the body was not an object"))
}

/// `zValidator('query', schema)`: the query string read by `read`.
pub(crate) fn zod_query<T>(
    raw_query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, HrError> {
    let values = query_values(raw_query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues
        .finish()
        .map_err(|invalid| HrError::from(invalid.into_response()))?;
    Ok(value)
}

/// `hrJson`'s hook: `{ error: { code: 'BAD_REQUEST', message, details: issues } }`.
fn readable(issues: &[Value]) -> Response {
    let mut messages: Vec<String> = Vec::new();
    for issue in issues {
        let message = describe_issue(issue);
        if !messages.contains(&message) {
            messages.push(message);
        }
    }
    let body = json!({
        "error": { "code": "BAD_REQUEST", "message": messages.join(". "), "details": issues },
    });
    (http::StatusCode::BAD_REQUEST, axum::Json(body)).into_response()
}

/// `fieldLabel(path)`: `breakMinutes` → "Break minutes"; array indexes
/// become `#2` (1-based).
fn field_label(path: &[Value]) -> String {
    let mut parts = Vec::new();
    for segment in path {
        match segment {
            Value::Number(index) => {
                let index = index.as_f64().unwrap_or(0.0);
                parts.push(format!("#{}", number_text(index + 1.0)));
            }
            Value::String(name) => parts.push(words(name)),
            other => parts.push(words(&other.to_string())),
        }
    }
    let label = parts.join(" ");
    let mut chars = label.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => label,
    }
}

/// `segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()`.
fn words(segment: &str) -> String {
    let chars: Vec<char> = segment.chars().collect();
    let mut out = String::with_capacity(segment.len() + 4);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        out.push(c);
        // A match consumes both characters, so the upper case one never
        // starts the next match (`aBC` → `a BC`).
        if (c.is_ascii_lowercase() || c.is_ascii_digit())
            && chars.get(i + 1).is_some_and(char::is_ascii_uppercase)
        {
            out.push(' ');
            out.push(chars[i + 1]);
            i += 2;
            continue;
        }
        i += 1;
    }
    out.replace('_', " ").to_lowercase()
}

/// A Zod bound as `${issue.minimum}` prints it.
fn bound_text(value: &Value) -> String {
    match value {
        Value::Number(number) => number_text(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn describe_too_small(field: &str, issue: &Value) -> String {
    let minimum = &issue["minimum"];
    match issue["type"].as_str() {
        Some("string") => {
            if minimum.as_f64().is_some_and(|min| min <= 1.0) {
                format!("{field} is required")
            } else {
                format!("{field} needs at least {} characters", bound_text(minimum))
            }
        }
        Some("array") => format!("{field} needs at least {} item(s)", bound_text(minimum)),
        _ => {
            let word = if issue["inclusive"] == true {
                "at least"
            } else {
                "more than"
            };
            format!("{field} must be {word} {}", bound_text(minimum))
        }
    }
}

fn describe_too_big(field: &str, issue: &Value) -> String {
    let maximum = &issue["maximum"];
    match issue["type"].as_str() {
        Some("string") => format!("{field} can be at most {} characters", bound_text(maximum)),
        Some("array") => format!("{field} can have at most {} item(s)", bound_text(maximum)),
        _ => {
            let word = if issue["inclusive"] == true {
                "at most"
            } else {
                "less than"
            };
            format!("{field} must be {word} {}", bound_text(maximum))
        }
    }
}

/// `describeIssue(issue)`: one readable sentence per Zod issue.
pub(crate) fn describe_issue(issue: &Value) -> String {
    let path = issue["path"].as_array().map_or(&[][..], Vec::as_slice);
    let field = if path.is_empty() {
        "Value".to_owned()
    } else {
        field_label(path)
    };
    let message = issue["message"].as_str().unwrap_or_default();
    match issue["code"].as_str() {
        Some("too_small") => describe_too_small(&field, issue),
        Some("too_big") => describe_too_big(&field, issue),
        Some("invalid_type") => {
            if issue["received"] == "undefined" {
                format!("{field} is required")
            } else {
                format!("{field} has the wrong type")
            }
        }
        Some("invalid_string") => {
            let format = match issue["validation"].as_str() {
                Some("email") => Some("a valid email address"),
                Some("url") => Some("a valid URL"),
                Some("datetime") => Some("a date and time"),
                _ => None,
            };
            match format {
                Some(format) => format!("{field} must be {format}"),
                None => format!("{field}: {message}"),
            }
        }
        Some("invalid_enum_value") => {
            let options = issue["options"]
                .as_array()
                .map(|options| {
                    options
                        .iter()
                        .map(|option| match option {
                            Value::String(text) => text.clone(),
                            other => bound_text(other),
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            format!("{field} must be one of {options}")
        }
        _ => format!("{field}: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // Cases from routes/weldhr/helpers.test.ts.
    #[test]
    fn labels_like_field_label() {
        assert_eq!(field_label(&[json!("breakMinutes")]), "Break minutes");
        assert_eq!(
            field_label(&[json!("scores"), json!(1), json!("score")]),
            "Scores #2 score"
        );
        assert_eq!(
            field_label(&[json!("allocationPercent")]),
            "Allocation percent"
        );
        assert_eq!(field_label(&[json!("end_date")]), "End date");
        assert_eq!(words("aBC"), "a bc");
    }

    #[test]
    fn describes_issues() {
        let small = json!({ "code": "too_small", "minimum": 0, "type": "number", "inclusive": true,
            "exact": false, "message": "x", "path": ["breakMinutes"] });
        assert_eq!(describe_issue(&small), "Break minutes must be at least 0");
        let required = json!({ "code": "invalid_type", "expected": "string", "received": "undefined",
            "path": ["name"], "message": "Required" });
        assert_eq!(describe_issue(&required), "Name is required");
        let one_of = json!({ "code": "invalid_enum_value", "options": ["in", "out"], "received": "x",
            "path": ["action"], "message": "x" });
        assert_eq!(describe_issue(&one_of), "Action must be one of in, out");
        let string = json!({ "code": "too_small", "minimum": 1, "type": "string", "inclusive": true,
            "exact": false, "message": "x", "path": [] });
        assert_eq!(describe_issue(&string), "Value is required");
    }
}
