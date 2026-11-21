//! What the order, discount and settings routes share: reading money and
//! dates from a body, mapping the domain's refusals to responses, and
//! presenting rows.

use axum::body::Bytes;
use http::header::CONTENT_TYPE;
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_commerce_domain::Error;
use weldsuite_commerce_domain::money::{self, Cents};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Field, Issues, Presence, Text, js_date_iso, js_trim};

use crate::Refusal;

/// A body that may be empty (`{}` then).
pub(crate) fn body_or_empty(headers: &HeaderMap, body: &Bytes) -> (HeaderMap, Bytes) {
    if body.iter().all(u8::is_ascii_whitespace) {
        let mut headers = headers.clone();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        (headers, Bytes::from_static(b"{}"))
    } else {
        (headers.clone(), body.clone())
    }
}

/// A non-negative amount (a string or a number) with at most two decimals
/// worth of cents, as cents.
pub(crate) fn read_money(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<Cents> {
    let parsed = match issues.string_or_number(fields, key, presence) {
        Field::Absent => return Field::Absent,
        Field::Null => return Field::Null,
        Field::Set(Value::Number(number)) => number.as_f64().and_then(|n| {
            (0.0..1e16)
                .contains(&n)
                .then(|| money::parse(&format!("{n}")))
                .flatten()
        }),
        Field::Set(Value::String(text)) => money::parse(js_trim(&text)),
        Field::Set(_) => None,
    };
    if let Some(cents) = parsed {
        return Field::Set(cents);
    }
    issues.custom(key, "Must be a non-negative amount, like 19.99");
    Field::Absent
}

/// An ISO date or date-time, normalised to `toISOString()`.
pub(crate) fn read_date(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<String> {
    match issues.text_with(fields, key, presence, Text::trimmed(Some(1), Some(40))) {
        Field::Set(text) => {
            if let Some(iso) = js_date_iso(&text) {
                Field::Set(iso)
            } else {
                issues.custom(key, "Must be an ISO date or date-time");
                Field::Absent
            }
        }
        other => other,
    }
}

/// A currency: three letters, upper-cased.
pub(crate) fn read_currency(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    presence: Presence,
) -> Field<String> {
    match issues.text_with(
        fields,
        "currency",
        presence,
        Text::trimmed(Some(3), Some(3)),
    ) {
        Field::Set(code) if code.chars().all(|c| c.is_ascii_alphabetic()) => {
            Field::Set(code.to_ascii_uppercase())
        }
        Field::Set(_) => {
            issues.custom("currency", "Must be an ISO 4217 code, like EUR");
            Field::Absent
        }
        other => other,
    }
}

/// A trimmed string up to `max`, blank as null.
pub(crate) fn read_text(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    max: usize,
) -> Field<String> {
    match issues.text_with(
        fields,
        key,
        Presence::Nullish,
        Text::trimmed(None, Some(max)),
    ) {
        Field::Set(text) if text.is_empty() => Field::Null,
        other => other,
    }
}

/// `{ name, company, line1, … }`: an address as the API writes it.
pub(crate) fn read_address(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
) -> Field<Value> {
    issues.nested(fields, key, Presence::Nullish, |issues, address| {
        let mut out = Map::new();
        for (field, max) in [
            ("name", 255),
            ("company", 255),
            ("line1", 255),
            ("line2", 255),
            ("postalCode", 30),
            ("city", 120),
            ("region", 120),
            ("country", 2),
            ("phone", 50),
            ("email", 255),
        ] {
            if let Field::Set(text) = read_text(issues, address, field, max) {
                out.insert(field.to_owned(), json!(text));
            }
        }
        Value::Object(out)
    })
}

/// `{ path: ["items", 2, "id"] }` from `items.2.id`.
fn path_of(field: &str) -> Vec<Value> {
    field
        .split('.')
        .map(|part| {
            part.parse::<usize>()
                .map_or_else(|_| json!(part), |index| json!(index))
        })
        .collect()
}

/// A 400 on `field` (a dotted path).
pub(crate) fn invalid(field: &str, message: &str) -> Refusal {
    let mut issues = Issues::default();
    issues.custom_at(&path_of(field), message);
    match issues.finish() {
        Err(invalid) => {
            use axum::response::IntoResponse;
            Refusal::Response(Box::new(invalid.into_response()))
        }
        Ok(()) => ApiError::internal().into(),
    }
}

fn conflict(code: &'static str, message: String, details: Option<Value>) -> Refusal {
    let error = ApiError::new(StatusCode::CONFLICT, code, message);
    match details {
        Some(details) => error.with_details(details).into(),
        None => error.into(),
    }
}

/// The domain's refusal as a response.
pub(crate) fn refuse(error: Error) -> Refusal {
    match error {
        Error::Database(error) => Refusal::Database(error),
        Error::NotFound { resource, id } => Refusal::not_found(resource, &id),
        Error::Invalid { field, message } => invalid(&field, &message),
        Error::LineProblems(problems) => {
            let mut issues = Issues::default();
            for problem in problems {
                issues.custom_at(
                    &path_of(&format!("items.{}", problem.index)),
                    problem.problem,
                );
            }
            match issues.finish() {
                Err(invalid) => {
                    use axum::response::IntoResponse;
                    Refusal::Response(Box::new(invalid.into_response()))
                }
                Ok(()) => ApiError::internal().into(),
            }
        }
        Error::Discount(problem) => conflict(
            "DISCOUNT_NOT_APPLICABLE",
            format!("The discount code does not apply: {}", problem.as_str()),
            Some(json!({ "reason": problem.as_str() })),
        ),
        Error::NotEditable(reason) => conflict("ORDER_NOT_EDITABLE", reason, None),
        Error::NotCancellable => conflict(
            "ORDER_NOT_CANCELLABLE",
            "The order can no longer be cancelled".to_owned(),
            None,
        ),
        Error::AlreadyPaid => {
            conflict("ALREADY_PAID", "The order is already paid".to_owned(), None)
        }
        Error::InvalidTransition { from, to } => conflict(
            "INVALID_STATUS_TRANSITION",
            format!("An order cannot move from {from} to {to}"),
            Some(json!({ "from": from, "to": to })),
        ),
        Error::SequenceBackwards { current } => conflict(
            "SEQUENCE_BACKWARDS",
            format!("The next order number cannot go below {current}"),
            Some(json!({ "current": current })),
        ),
        error @ Error::SellerEntityRequired => {
            conflict("SELLER_ENTITY_REQUIRED", error.to_string(), None)
        }
        Error::SellerNotEu { country } => conflict(
            "SELLER_ENTITY_NOT_EU",
            format!(
                "The seller entity is in {country}: WeldCommerce calculates VAT for EU sellers only"
            ),
            Some(json!({ "country": country })),
        ),
        Error::DestinationNotSupported { country } => conflict(
            "DESTINATION_NOT_SUPPORTED",
            format!("VAT to {country} is not supported yet"),
            Some(json!({ "country": country })),
        ),
        error @ Error::TaxLocked => conflict("ORDER_TAX_LOCKED", error.to_string(), None),
        Error::TaxEngineUnavailable(why) => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "TAX_ENGINE_UNAVAILABLE",
            format!("The VAT could not be calculated: {why}"),
        )
        .into(),
    }
}

/// An ISO timestamp as JavaScript writes it, from a Postgres one.
pub(crate) fn iso(value: &Value) -> Value {
    value
        .as_str()
        .map_or(Value::Null, |text| json!(crate::table::js_date(text)))
}

/// A numeric column as text with two decimals; `fallback` when null.
pub(crate) fn amount(value: &Value, fallback: &str) -> Value {
    json!(value.as_str().unwrap_or(fallback))
}
