//! What the engine needs of JavaScript's semantics to decide exactly like
//! `@weldsuite/forms-engine`: `trim()`, `String(n)`, `JSON.stringify` of a
//! number, `Math.round`, string length and ordering in UTF-16 code units.

use std::cmp::Ordering;

use serde::Serializer;
use serde_json::Value;

/// JavaScript's white space and line terminators (`\s`, `trim()`): Unicode
/// `Zs` plus tab, vertical tab, form feed, the BOM, LF, CR, LS and PS. Not
/// U+0085, which Rust's `char::is_whitespace` includes.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// The same set as a regex character class body (for `\s` and `\S`).
pub(crate) const JS_SPACE_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// `String.prototype.trim()`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `String(n)`, with `-0` as `0` (what `formatNumber` writes).
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
        // Rust's shortest round-trip digits, without an exponent in this range.
        return format!("{number}");
    }
    // `1.5e21` → `1.5e+21`; `1e-7` stays.
    let text = format!("{number:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// Whether `number` is written as an integer by `JSON.stringify`, and fits one.
#[allow(clippy::cast_possible_truncation)] // whole and below 2^63: exact
fn whole(number: f64) -> Option<i64> {
    // 2^63: every whole float below it converts to `i64` exactly.
    const LIMIT: f64 = 9_223_372_036_854_775_808.0;
    (number.is_finite() && number.fract() == 0.0 && number.abs() < LIMIT).then_some(number as i64)
}

/// A number as `JSON.stringify` writes it: whole numbers as integers (`3`,
/// never `3.0`), `-0` as `0`, non-finite as `null`.
pub fn number_value(number: f64) -> Value {
    match whole(number) {
        Some(int) => Value::from(int),
        None => serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number),
    }
}

/// `serialize_with` for a number field: [`number_value`]'s shape.
#[allow(clippy::trivially_copy_pass_by_ref)] // serde passes fields by reference
pub(crate) fn ser_num<S: Serializer>(number: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    match whole(*number) {
        Some(int) => serializer.serialize_i64(int),
        None if number.is_finite() => serializer.serialize_f64(*number),
        None => serializer.serialize_none(),
    }
}

/// `serialize_with` for an optional number field (skipped when absent).
#[allow(clippy::ref_option)] // serde passes fields by reference
pub(crate) fn ser_opt_num<S: Serializer>(
    number: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match number {
        Some(number) => ser_num(number, serializer),
        None => serializer.serialize_none(),
    }
}

/// `Math.round(x)`: the nearest integer, a tie toward +∞ (Rust's
/// `f64::round` takes a negative tie away from zero instead).
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    // Exact: `x - floor(x)` loses nothing.
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `Number.isInteger(n)`.
pub fn is_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0
}

/// `s.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `Array.from(s).length`: code points.
pub fn code_points(text: &str) -> usize {
    text.chars().count()
}

/// `a < b` on JavaScript strings: by UTF-16 code units.
pub fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `typeof value === 'number' && Number.isFinite(value)` for a JSON value.
pub(crate) fn finite_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_written_like_javascript() {
        for (number, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-9.99, "-9.99"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e20, "100000000000000000000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (0.333_333_333_3, "0.3333333333"),
            (123_456_789.125, "123456789.125"),
        ] {
            assert_eq!(number_text(number), text, "{number}");
        }
    }

    #[test]
    fn json_numbers_are_integers_when_whole() {
        assert_eq!(number_value(3.0).to_string(), "3");
        assert_eq!(number_value(-0.0).to_string(), "0");
        assert_eq!(number_value(2.5).to_string(), "2.5");
        assert_eq!(number_value(f64::NAN), Value::Null);
    }

    #[test]
    fn rounding_takes_ties_up() {
        assert!((js_round(2.5) - 3.0).abs() < f64::EPSILON);
        assert!((js_round(-2.5) + 2.0).abs() < f64::EPSILON);
        assert!(js_round(0.499_999_999_999_999_94).abs() < f64::EPSILON);
    }

    #[test]
    fn trim_is_javascripts() {
        assert_eq!(js_trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn strings_compare_by_utf16_units() {
        // U+FF61 sorts after U+1F600 in UTF-16 (0xFF61 > 0xD83D), before it by code point.
        assert_eq!(js_cmp("\u{ff61}", "\u{1f600}"), Ordering::Greater);
        assert_eq!(utf16_len("a\u{1f600}"), 3);
        assert_eq!(code_points("a\u{1f600}"), 2);
    }
}
