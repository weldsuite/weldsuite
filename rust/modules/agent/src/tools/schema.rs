//! Tool arguments are validated against the tool's JSON schema before it runs
//! (the TypeScript tools `parse` their Zod schema first). A bad argument goes
//! back to the model as a tool error, never to the database.
//!
//! The subset of JSON Schema the tools use: `object` with `properties` and
//! `required`, `string` (`minLength`, `maxLength`, `enum`, `format: email`),
//! `integer` and `number` (`minimum`, `maximum`), `boolean`, and `array`
//! (`items`, `maxItems`, `minItems`). Unknown properties are dropped, as Zod
//! strips them.

use serde_json::{Map, Value};

/// The arguments cleaned against `schema`, or what is wrong with them.
///
/// # Errors
///
/// The first violation, as a sentence the model can act on.
pub fn validate(schema: &Value, args: &Value) -> Result<Value, String> {
    check(schema, args, "arguments")
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[allow(clippy::too_many_lines)] // one arm per JSON type
fn check(schema: &Value, value: &Value, path: &str) -> Result<Value, String> {
    let expected = schema
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("object");
    match expected {
        "object" => {
            // A model may send nothing for a tool without arguments.
            let empty = Map::new();
            let fields = match value {
                Value::Object(fields) => fields,
                Value::Null => &empty,
                other => return Err(format!("{path} must be an object, got {}", kind(other))),
            };
            let properties = schema.get("properties").and_then(Value::as_object);
            let mut out = Map::new();
            if let Some(properties) = properties {
                for (key, property) in properties {
                    match fields.get(key) {
                        None | Some(Value::Null) => {
                            if let Some(default) = property.get("default") {
                                out.insert(key.clone(), default.clone());
                            }
                        }
                        Some(found) => {
                            out.insert(
                                key.clone(),
                                check(property, found, &format!("{path}.{key}"))?,
                            );
                        }
                    }
                }
            }
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for key in required.iter().filter_map(Value::as_str) {
                    if !out.contains_key(key) {
                        return Err(format!("{path}.{key} is required"));
                    }
                }
            }
            Ok(Value::Object(out))
        }
        "string" => {
            let Value::String(text) = value else {
                return Err(format!("{path} must be a string, got {}", kind(value)));
            };
            let length = text.chars().count();
            let limit = |key: &str| {
                schema
                    .get(key)
                    .and_then(Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok())
            };
            if let Some(min) = limit("minLength")
                && length < min
            {
                return Err(format!("{path} must be at least {min} characters"));
            }
            if let Some(max) = limit("maxLength")
                && length > max
            {
                return Err(format!("{path} must be at most {max} characters"));
            }
            if let Some(options) = schema.get("enum").and_then(Value::as_array)
                && !options.iter().any(|option| option == value)
            {
                let names: Vec<&str> = options.iter().filter_map(Value::as_str).collect();
                return Err(format!("{path} must be one of: {}", names.join(", ")));
            }
            if schema.get("format").and_then(Value::as_str) == Some("email")
                && !looks_like_email(text)
            {
                return Err(format!("{path} must be an email address"));
            }
            Ok(value.clone())
        }
        "integer" | "number" => {
            let Some(number) = value.as_f64() else {
                return Err(format!("{path} must be a number, got {}", kind(value)));
            };
            if expected == "integer" && number.fract() != 0.0 {
                return Err(format!("{path} must be a whole number"));
            }
            if let Some(min) = schema.get("minimum").and_then(Value::as_f64)
                && number < min
            {
                return Err(format!("{path} must be at least {min}"));
            }
            if let Some(max) = schema.get("maximum").and_then(Value::as_f64)
                && number > max
            {
                return Err(format!("{path} must be at most {max}"));
            }
            Ok(value.clone())
        }
        "boolean" => match value {
            Value::Bool(_) => Ok(value.clone()),
            other => Err(format!("{path} must be true or false, got {}", kind(other))),
        },
        "array" => {
            let Value::Array(items) = value else {
                return Err(format!("{path} must be a list, got {}", kind(value)));
            };
            let limit = |key: &str| {
                schema
                    .get(key)
                    .and_then(Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok())
            };
            if let Some(min) = limit("minItems")
                && items.len() < min
            {
                return Err(format!("{path} needs at least {min} item(s)"));
            }
            if let Some(max) = limit("maxItems")
                && items.len() > max
            {
                return Err(format!("{path} can have at most {max} item(s)"));
            }
            let item_schema = schema.get("items");
            let mut out = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                out.push(match item_schema {
                    Some(item_schema) => check(item_schema, item, &format!("{path}[{index}]"))?,
                    None => item.clone(),
                });
            }
            Ok(Value::Array(out))
        }
        _ => Ok(value.clone()),
    }
}

/// `z.string().email()`, loosely: something before and after one `@`, and a
/// dot in the domain.
fn looks_like_email(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !text.chars().any(char::is_whitespace)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "search": { "type": "string", "maxLength": 5 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                "kind": { "type": "string", "enum": ["a", "b"], "default": "a" },
                "tags": { "type": "array", "items": { "type": "string" }, "maxItems": 2 },
            },
            "required": ["search"],
        })
    }

    #[test]
    fn good_arguments_are_cleaned_and_defaults_filled() {
        let out = validate(&schema(), &json!({ "search": "ab", "extra": 1 })).unwrap();
        assert_eq!(out, json!({ "search": "ab", "kind": "a" }));
    }

    #[test]
    fn bad_arguments_say_what_is_wrong() {
        assert_eq!(
            validate(&schema(), &json!({})).unwrap_err(),
            "arguments.search is required"
        );
        assert!(
            validate(&schema(), &json!({ "search": "abcdef" }))
                .unwrap_err()
                .contains("at most 5")
        );
        assert!(
            validate(&schema(), &json!({ "search": "a", "limit": 0 }))
                .unwrap_err()
                .contains("at least 1")
        );
        assert!(
            validate(&schema(), &json!({ "search": "a", "limit": 1.5 }))
                .unwrap_err()
                .contains("whole number")
        );
        assert!(
            validate(&schema(), &json!({ "search": "a", "kind": "c" }))
                .unwrap_err()
                .contains("one of")
        );
        assert!(
            validate(
                &schema(),
                &json!({ "search": "a", "tags": ["x", "y", "z"] })
            )
            .unwrap_err()
            .contains("at most 2")
        );
        assert!(validate(&schema(), &json!("nope")).is_err());
    }

    #[test]
    fn no_arguments_is_an_empty_object() {
        let none = json!({ "type": "object", "properties": {} });
        assert_eq!(validate(&none, &Value::Null).unwrap(), json!({}));
    }

    #[test]
    fn emails_are_checked() {
        let s = json!({ "type": "string", "format": "email" });
        assert!(validate(&s, &json!("a@b.co")).is_ok());
        assert!(validate(&s, &json!("a@b")).is_err());
    }
}
