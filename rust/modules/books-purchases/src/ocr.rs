//! What books-api's `services/accounting-ocr` does without the model: a
//! stored OCR result read back (`normalizeOcrResult`), the bill lines it
//! pre-fills (`lineItemsForBill`) and the contact it matches
//! (`matchVendorToContact`). The model call itself runs on Workers AI and is
//! not served on the Kubernetes editions.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::js::{math_round, number_text, number_value};
use weldsuite_books_domain::jurisdictions::js_trim;

/// `asNumber(value)`: a finite number, else `None`.
fn as_number(value: Option<&Value>) -> Option<f64> {
    let n = match value? {
        Value::Null => return None,
        Value::String(s) if s.is_empty() => return None,
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => weldsuite_kit::validation::js_number(s),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Array(_) | Value::Object(_) => f64::NAN,
    };
    n.is_finite().then_some(n)
}

fn number_or_null(n: Option<f64>) -> Value {
    n.map_or(Value::Null, number_value)
}

/// `asIsoDate(value)`: `yyyy-mm-dd`, a Dutch `d-m-yyyy` turned around, the
/// trimmed text otherwise.
fn as_iso_date(value: Option<&Value>) -> Value {
    let Some(Value::String(raw)) = value else {
        return Value::Null;
    };
    let trimmed = js_trim(raw);
    if trimmed.is_empty() {
        return Value::Null;
    }
    let b = trimmed.as_bytes();
    let iso = b.len() >= 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| b[*i].is_ascii_digit());
    if iso {
        return json!(&trimmed[..10]);
    }
    let parts: Vec<&str> = trimmed.split(['.', '/', '-']).collect();
    let separators_ok = trimmed
        .chars()
        .filter(|c| matches!(c, '.' | '/' | '-'))
        .count()
        == 2;
    if separators_ok
        && let [d, m, y] = parts.as_slice()
        && (1..=2).contains(&d.len())
        && (1..=2).contains(&m.len())
        && y.len() == 4
        && [d, m, y]
            .iter()
            .all(|p| p.bytes().all(|c| c.is_ascii_digit()))
    {
        return json!(format!("{y}-{m:0>2}-{d:0>2}"));
    }
    json!(trimmed)
}

fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// `normalizeOcrResult(parsed)`.
pub(crate) fn normalize_ocr_result(parsed: &Value) -> Value {
    let raw = parsed.as_object().cloned().unwrap_or_default();
    let get = |key: &str| raw.get(key).filter(|v| !v.is_null());
    let empty = Value::Object(Map::new());
    let vendor = get("vendor").unwrap_or(&empty);
    let field = |key: &str| or_null(vendor.get(key).filter(|v| !v.is_null()));
    let line_items: Vec<Value> = get("lineItems")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    json!({
                        "description": item.get("description").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!("")),
                        "quantity": number_or_null(as_number(item.get("quantity"))),
                        "unitPrice": number_or_null(as_number(item.get("unitPrice"))),
                        "taxRate": number_or_null(as_number(item.get("taxRate"))),
                        "total": number_or_null(as_number(item.get("total"))),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let breakdown: Vec<Value> = get("taxBreakdown")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    json!({
                        "rate": number_value(as_number(row.get("rate")).unwrap_or(0.0)),
                        "taxableAmount": number_value(as_number(row.get("taxableAmount")).unwrap_or(0.0)),
                        "taxAmount": number_value(as_number(row.get("taxAmount")).unwrap_or(0.0)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let confidence = get("confidence");
    json!({
        "vendor": {
            "name": field("name"),
            "address": field("address"),
            "taxNumber": field("taxNumber"),
            "kvkNumber": field("kvkNumber"),
            "iban": field("iban"),
            "bic": field("bic"),
        },
        "invoiceNumber": or_null(get("invoiceNumber")),
        "invoiceDate": as_iso_date(get("invoiceDate")),
        "dueDate": as_iso_date(get("dueDate")),
        "currency": get("currency").cloned().unwrap_or_else(|| json!("EUR")),
        "lineItems": line_items,
        "subtotal": number_or_null(as_number(get("subtotal"))),
        "taxBreakdown": breakdown,
        "totalTax": number_or_null(as_number(get("totalTax"))),
        "total": number_or_null(as_number(get("total"))),
        "paymentReference": or_null(get("paymentReference")),
        "iban": or_null(get("iban")),
        "confidence": {
            "overall": number_value(as_number(confidence.and_then(|c| c.get("overall"))).unwrap_or(0.0)),
            "fields": confidence.and_then(|c| c.get("fields")).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!({})),
        },
        "rawText": or_null(get("rawText")),
    })
}

fn num(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

/// `dominantTaxRate(ocr)`.
fn dominant_tax_rate(ocr: &Value) -> Option<f64> {
    if let Some(rate) = ocr["taxBreakdown"].get(0).and_then(|row| num(row, "rate")) {
        return Some(rate);
    }
    ocr["lineItems"]
        .as_array()?
        .iter()
        .find_map(|line| num(line, "taxRate"))
}

/// `exclusiveAmount(ocr)`: the amount without VAT, for a one-line expense.
fn exclusive_amount(ocr: &Value) -> Option<f64> {
    if let Some(subtotal) = num(ocr, "subtotal").filter(|n| n.is_finite()) {
        return Some(subtotal);
    }
    let from_lines: f64 = ocr["lineItems"].as_array().map_or(0.0, |lines| {
        lines
            .iter()
            .filter_map(|line| Some(num(line, "unitPrice")? * num(line, "quantity").unwrap_or(1.0)))
            .sum()
    });
    if from_lines > 0.0 {
        return Some(from_lines);
    }
    let total = num(ocr, "total").filter(|n| n.is_finite())?;
    match dominant_tax_rate(ocr) {
        Some(rate) if rate > 0.0 => Some(total / (1.0 + rate / 100.0)),
        _ => Some(total),
    }
}

fn truthy_text(value: &Value) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(false) => None,
        Value::String(s) if s.is_empty() => None,
        Value::Number(n) if n.as_f64() == Some(0.0) => None,
        other => Some(other.clone()),
    }
}

/// `lineItemsForBill(ocr)`: the OCR lines, or one line from the total.
pub(crate) fn line_items_for_bill(ocr: &Value) -> Vec<Value> {
    let lines = ocr["lineItems"].as_array().cloned().unwrap_or_default();
    if !lines.is_empty() {
        return lines
            .iter()
            .enumerate()
            .map(|(index, line)| {
                json!({
                    "description": truthy_text(&line["description"]).unwrap_or_else(|| json!("Item")),
                    "quantity": number_text(num(line, "quantity").unwrap_or(1.0)),
                    "unitPrice": number_text(num(line, "unitPrice").unwrap_or(0.0)),
                    "taxRate": num(line, "taxRate").map_or(Value::Null, |r| json!(number_text(r))),
                    "sortOrder": index,
                })
            })
            .collect();
    }
    let Some(exclusive) = exclusive_amount(ocr) else {
        return Vec::new();
    };
    vec![json!({
        "description": truthy_text(&ocr["vendor"]["name"]).unwrap_or_else(|| json!("Scanned receipt")),
        "quantity": "1",
        "unitPrice": number_text(math_round(exclusive * 100.0) / 100.0),
        "taxRate": dominant_tax_rate(ocr).map_or(Value::Null, |r| json!(number_text(r))),
        "sortOrder": 0,
    })]
}

/// `matchVendorToContact(db, schema, ocr)`: a live contact with the
/// document's IBAN. books-api also asks for `parties.taxNumber` and
/// `parties.name`, which the table doesn't have: Drizzle can't build that
/// query, so a result with a VAT number or a vendor name fails (the
/// route's 500), as it does on Global.
pub(crate) async fn match_vendor_to_contact(
    db: &sqlx::PgPool,
    ocr: &Value,
) -> Result<Option<String>, sqlx::Error> {
    let vendor = &ocr["vendor"];
    let tax_number = truthy_text(&vendor["taxNumber"]);
    let iban = truthy_text(&vendor["iban"]).or_else(|| truthy_text(&ocr["iban"]));
    let name = truthy_text(&vendor["name"]);
    if tax_number.is_some() || name.is_some() {
        return Err(sqlx::Error::Protocol(
            "parties has no taxNumber or name column to match on".to_owned(),
        ));
    }
    let Some(iban) = iban else {
        return Ok(None);
    };
    sqlx::query_scalar("select id from parties where iban = $1 and deleted_at is null limit 1")
        .bind(
            iban.as_str()
                .map_or_else(|| iban.to_string(), str::to_owned),
        )
        .fetch_optional(db)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_stored_result() {
        let ocr = normalize_ocr_result(&json!({
            "vendor": { "name": "Shop" },
            "invoiceDate": "4-8-2026",
            "dueDate": "2026-09-01T00:00:00Z",
            "total": "121",
            "taxBreakdown": [{ "rate": 21 }],
        }));
        assert_eq!(ocr["invoiceDate"], json!("2026-08-04"));
        assert_eq!(ocr["dueDate"], json!("2026-09-01"));
        assert_eq!(ocr["currency"], json!("EUR"));
        assert_eq!(ocr["total"], json!(121));
        assert_eq!(
            line_items_for_bill(&ocr),
            [
                json!({ "description": "Shop", "quantity": "1", "unitPrice": "100", "taxRate": "21", "sortOrder": 0 })
            ]
        );
    }
}
