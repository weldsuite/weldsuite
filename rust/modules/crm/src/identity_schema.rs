//! The pieces the company and person schemas share
//! (`app-api-client/schemas/companies.ts`, `core-api-client/schemas/people.ts`):
//! addresses, money, `email` as an email or `''`, URLs that are normalised,
//! the optimistic-concurrency `version`, and the lifecycle stages.

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

/// `LIFECYCLE_STAGES`.
pub(crate) const LIFECYCLE_STAGES: &[&str] = &[
    "subscriber",
    "lead",
    "marketing_qualified",
    "sales_qualified",
    "opportunity",
    "customer",
    "evangelist",
];

const ADDRESS_FIELDS: [&str; 9] = [
    "line1",
    "line2",
    "street",
    "houseNumber",
    "postalCode",
    "city",
    "state",
    "province",
    "country",
];

/// `addressSchema` (`.passthrough()`): the known fields are optional
/// strings; other keys are kept.
fn address_fields(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    for key in ADDRESS_FIELDS {
        issues.text_with(fields, key, Presence::Optional, Text::default());
    }
    Value::Object(fields.clone())
}

/// `addressSchema` at `key` with `presence`.
pub(crate) fn address(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    out: &mut Map<String, Value>,
) {
    match issues.nested(body, key, presence, address_fields) {
        Field::Set(value) => {
            out.insert(key.to_owned(), value);
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

/// `z.array(addressSchema).optional()` at `key`.
pub(crate) fn addresses(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    out: &mut Map<String, Value>,
) {
    let field = issues.list(body, key, Presence::Optional, None, None, |issues, item| {
        issues.object(item).map(|fields| {
            let fields = fields.clone();
            address_fields(issues, &fields)
        })
    });
    if let Field::Set(items) = field {
        out.insert(key.to_owned(), Value::Array(items));
    }
}

/// `moneySchema.nullish()` at `key`: `{ amount ≥ 0, currency of length 3 }`.
pub(crate) fn money(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    out: &mut Map<String, Value>,
) {
    let field = issues.nested(body, key, Presence::Nullish, |issues, fields| {
        let amount = issues.number(
            fields,
            "amount",
            Presence::Required,
            Number {
                coerce: false,
                int: false,
                min: Some(0.0),
                max: None,
            },
        );
        let currency = issues.text_with(fields, "currency", Presence::Required, Text::default());
        if let Field::Set(code) = &currency {
            let length = code.encode_utf16().count();
            if length != 3 {
                let (code_name, bound) = if length < 3 {
                    ("too_small", "minimum")
                } else {
                    ("too_big", "maximum")
                };
                issues.issue_at(
                    "currency",
                    json!({
                        "code": code_name,
                        bound: 3,
                        "type": "string",
                        "inclusive": true,
                        "exact": true,
                        "message": "String must contain exactly 3 character(s)",
                    }),
                );
            }
        }
        json!({
            "amount": amount.into_option().map_or(Value::Null, crate::schema::number_value),
            "currency": currency.into_option(),
        })
    });
    match field {
        Field::Set(value) => {
            out.insert(key.to_owned(), value);
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

/// `z.array(z.string().email()).optional()` at `key`.
pub(crate) fn emails(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    out: &mut Map<String, Value>,
) {
    let rules = Text {
        format: Some(weldsuite_kit::validation::Format::Email),
        ..Text::default()
    };
    if let Field::Set(items) =
        issues.list(body, key, Presence::Optional, None, None, |issues, item| {
            issues.item_text(item, rules)
        })
    {
        out.insert(key.to_owned(), json!(items));
    }
}

/// `z.string().email().optional().or(z.literal(''))` at `key`: a union, so
/// its issue settles after the plain checks and refinements (call it
/// last). A non-empty string that isn't an email is the email issue; any
/// other type is `invalid_union`.
pub(crate) fn email_or_empty(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    out: &mut Map<String, Value>,
) {
    match body.get(key) {
        None => {}
        Some(Value::String(text)) => {
            if text.is_empty() {
                out.insert(key.to_owned(), json!(""));
            } else {
                let rules = Text {
                    format: Some(weldsuite_kit::validation::Format::Email),
                    ..Text::default()
                };
                if let Field::Set(email) = issues.text_with(body, key, Presence::Optional, rules) {
                    out.insert(key.to_owned(), json!(email));
                }
            }
        }
        Some(other) => {
            let received = match other {
                Value::Null => "null",
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::Array(_) => "array",
                _ => "object",
            };
            issues.issue_at(
                key,
                json!({
                    "code": "invalid_union",
                    "unionErrors": [
                        { "issues": [{
                            "code": "invalid_type", "expected": "string", "received": received,
                            "path": [key], "message": format!("Expected string, received {received}"),
                        }], "name": "ZodError" },
                        { "issues": [{
                            "received": other, "code": "invalid_literal", "expected": "",
                            "path": [key], "message": "Invalid literal value, expected \"\"",
                        }], "name": "ZodError" },
                    ],
                    "message": "Invalid input",
                }),
            );
        }
    }
}

/// `/^https?:\/\//i.test(raw) ? raw : \`https://${raw}\``.
fn normalize_url(raw: &str) -> String {
    let lower = raw.get(..8).unwrap_or(raw).to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    }
}

/// `isValidWebsiteValue(raw)`: `new URL(normalised).hostname.includes('.')`.
fn valid_url(raw: &str) -> bool {
    url::Url::parse(&normalize_url(raw))
        .ok()
        .and_then(|url| url.host_str().map(|host| host.contains('.')))
        .unwrap_or(false)
}

/// A URL field: `z.string().max(max).refine(valid, message).transform(normalise).optional()`.
/// Reads the string (plain checks), and returns the refinement to run
/// once every plain field is read.
pub(crate) fn url_field(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    max: usize,
    out: &mut Map<String, Value>,
) {
    if let Field::Set(text) =
        issues.text_with(body, key, Presence::Optional, Text::length(None, Some(max)))
    {
        out.insert(key.to_owned(), json!(text));
    }
}

/// The URL field's refinement and transform (tier 1).
pub(crate) fn url_refine(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    message: &str,
    out: &mut Map<String, Value>,
) {
    if let Some(Value::String(raw)) = body.get(key) {
        if !raw.is_empty() && !valid_url(raw) {
            issues.custom(key, message);
            out.remove(key);
        } else if let Some(Value::String(kept)) = out.get(key).cloned()
            && !kept.is_empty()
        {
            out.insert(key.to_owned(), json!(normalize_url(&kept)));
        }
    }
}

/// `z.number().int().positive().optional()` at `key`.
pub(crate) fn positive_int(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    out: &mut Map<String, Value>,
) {
    let field = issues.number(
        body,
        key,
        Presence::Optional,
        Number {
            coerce: false,
            int: true,
            min: None,
            max: None,
        },
    );
    if let Field::Set(number) = field {
        if number <= 0.0 {
            issues.issue_at(
                key,
                json!({
                    "code": "too_small", "minimum": 0, "type": "number", "inclusive": false,
                    "exact": false, "message": "Number must be greater than 0",
                }),
            );
        } else {
            out.insert(key.to_owned(), crate::schema::number_value(number));
        }
    }
}
