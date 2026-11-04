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

/// `number.toFixed(digits)`: the exact decimal value rounded half away
/// from zero (JavaScript picks the larger `n` on a tie), unlike Rust's
/// formatter, which rounds a tie to even.
pub fn to_fixed(number: f64, digits: usize) -> String {
    if !number.is_finite() || number.abs() >= 1e21 {
        return number_text(number);
    }
    let negative = number < 0.0;
    let exact = format!("{:.80}", number.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let kept = &fraction[..digits.min(fraction.len())];
    let rest = &fraction[digits.min(fraction.len())..];
    let round_up = rest.as_bytes().first().is_some_and(|d| *d >= b'5');
    let mut all: Vec<u8> = whole.bytes().chain(kept.bytes()).collect();
    if round_up {
        let mut i = all.len();
        loop {
            if i == 0 {
                all.insert(0, b'1');
                break;
            }
            i -= 1;
            if all[i] == b'9' {
                all[i] = b'0';
            } else {
                all[i] += 1;
                break;
            }
        }
    }
    let split = all.len() - digits;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    out.push_str(&String::from_utf8_lossy(&all[..split]));
    if digits > 0 {
        out.push('.');
        out.push_str(&String::from_utf8_lossy(&all[split..]));
    }
    out
}

/// `asRecord(value)`: a plain object, else `None`.
pub fn record(value: Option<&Value>) -> Option<&serde_json::Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `typeof value === 'string' ? value : null`.
pub fn string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// `typeof value === 'string' && value ? value : null`.
pub fn nonempty(value: Option<&Value>) -> Option<&str> {
    string(value).filter(|s| !s.is_empty())
}

/// `typeof value === 'number' && Number.isFinite(value) ? value : null`.
pub fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// `new Date(seconds * 1000).toISOString()` for a finite number, else null.
pub fn iso_from_unix(value: Option<&Value>) -> Option<String> {
    finite(value).and_then(|s| weldsuite_kit::validation::js_iso_from_millis(s * 1000.0))
}

/// `Date.now()`.
pub fn now_ms() -> f64 {
    #[allow(clippy::cast_precision_loss)]
    let ms = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    #[allow(clippy::cast_precision_loss)]
    {
        ms as f64
    }
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    weldsuite_kit::validation::js_iso_from_millis(now_ms()).unwrap_or_default()
}

/// `Date.parse(text)` (`NaN` as `None`).
pub fn date_parse(text: &str) -> Option<f64> {
    weldsuite_kit::validation::js_date_parse(text)
}

/// `encodeURIComponent(text)`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            let _ = std::fmt::Write::write_fmt(&mut out, format_args!("%{byte:02X}"));
        }
    }
    out
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
