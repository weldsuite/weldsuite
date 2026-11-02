//! JavaScript number formatting the connectors rely on.

use serde_json::{Value, json};

/// `String(number)`.
pub fn number_text(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_owned();
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    let abs = number.abs();
    if (1e-6..1e21).contains(&abs) {
        return format!("{number}");
    }
    let text = format!("{number:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// A number as `JSON.stringify` writes it: whole numbers as integers,
/// non-finite as `null`.
pub fn number_value(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        json!(number as i64)
    } else if number.is_finite() {
        json!(number)
    } else {
        Value::Null
    }
}
