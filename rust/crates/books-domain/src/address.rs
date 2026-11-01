//! Postal addresses (`@weldsuite/books-domain/accounting-address`): either
//! shape on input (the shared `PostalAddress`, or the legacy Dutch one with
//! `street` + `houseNumber` and `province`), stored in the shared shape.

use serde_json::{Map, Value};

use crate::jurisdictions::js_trim;

const FIELDS: [&str; 7] = [
    "line1",
    "line2",
    "city",
    "state",
    "postalCode",
    "country",
    "county",
];

fn clean(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let trimmed = js_trim(text);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `normalizePostalAddress(input)`: the shared shape, fields trimmed, empty
/// ones left out, the country in upper case; `None` when nothing is left.
pub fn normalize_postal_address(input: Option<&Value>) -> Option<Value> {
    let raw = input?.as_object()?;
    let street = clean(raw.get("street"));
    let house_number = clean(raw.get("houseNumber"));
    let legacy: Vec<String> = [street, house_number].into_iter().flatten().collect();
    let legacy_line1 = (!legacy.is_empty()).then(|| legacy.join(" "));
    let values = [
        clean(raw.get("line1")).or(legacy_line1),
        clean(raw.get("line2")),
        clean(raw.get("city")),
        clean(raw.get("state")).or_else(|| clean(raw.get("province"))),
        clean(raw.get("postalCode")),
        clean(raw.get("country")).map(|c| c.to_uppercase()),
        clean(raw.get("county")),
    ];
    let mut result = Map::new();
    for (field, value) in FIELDS.iter().zip(values) {
        if let Some(value) = value {
            result.insert((*field).to_owned(), Value::String(value));
        }
    }
    (!result.is_empty()).then_some(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn either_shape_comes_out_shared() {
        let legacy =
            json!({ "street": "Damrak ", "houseNumber": "1", "province": "NH", "country": "nl" });
        assert_eq!(
            normalize_postal_address(Some(&legacy)),
            Some(json!({ "line1": "Damrak 1", "state": "NH", "country": "NL" }))
        );
        assert_eq!(
            normalize_postal_address(Some(&json!({ "city": "  " }))),
            None
        );
    }
}
