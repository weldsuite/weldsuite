//! JavaScript's number and date semantics, where the TypeScript engines rely
//! on them: `Math.round`, `toFixed`, `String(n)`, `JSON.stringify` of whole
//! numbers, and `Date` arithmetic on `YYYY-MM-DD` strings.

use serde::Serialize;
use serde_json::{Value, json};

use crate::PayrollError;

/// `Math.round(x)`: halves round up (towards +∞), exactly.
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `Math.trunc(x)`.
pub fn trunc(x: f64) -> f64 {
    x.trunc()
}

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

/// `x.toFixed(digits)`: the exact binary value rounded half up (away from
/// zero, the sign apart), as JavaScript does; `String(x)` from 1e21.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number_text(x);
    }
    let negative = x < 0.0;
    // Every finite double has an exact decimal expansion of at most 1074
    // fractional digits: print it whole, then round by hand.
    let exact = format!("{:.1100}", x.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut out: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    let rest = &fraction.as_bytes()[digits.min(fraction.len())..];
    if rest.first().is_some_and(|d| *d >= b'5') {
        let mut i = out.len();
        loop {
            if i == 0 {
                out.insert(0, b'1');
                break;
            }
            i -= 1;
            if out[i] == b'9' {
                out[i] = b'0';
            } else {
                out[i] += 1;
                break;
            }
        }
    }
    let split = out.len() - digits;
    let mut text = String::from_utf8_lossy(&out[..split]).into_owned();
    if digits > 0 {
        text.push('.');
        text.push_str(&String::from_utf8_lossy(&out[split..]));
    }
    // `(-0.001).toFixed(2)` is "-0.00": the sign of x, not of the digits.
    if negative {
        text.insert(0, '-');
    }
    text
}

/// `String.prototype.trim`: Unicode white space and the BOM.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `Number.isInteger(x)`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// `Number(text)` for the strings JavaScript converts: trimmed, decimal or
/// `0x`/`0o`/`0b`, `Infinity`; the empty string is 0; anything else NaN.
pub fn number_of(text: &str) -> f64 {
    let t = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return if !digits.is_empty() && digits.chars().all(|c| c.is_digit(radix)) {
                digits.chars().fold(0.0, |acc, c| {
                    acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
                })
            } else {
                f64::NAN
            };
        }
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let valid = {
        let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
            Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
            None => (unsigned, None),
        };
        let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        let mantissa_ok = (!int.is_empty() || !frac.is_empty())
            && int.bytes().all(|b| b.is_ascii_digit())
            && frac.bytes().all(|b| b.is_ascii_digit());
        let exponent_ok = exponent.is_none_or(|e| {
            let digits = e.strip_prefix(['+', '-']).unwrap_or(e);
            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
        });
        mantissa_ok && exponent_ok
    };
    if !valid {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
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

/// Whole floats become integers, recursively: what `JSON.stringify` writes.
pub fn whole_numbers(value: Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => {
            number_value(number.as_f64().unwrap_or(f64::NAN))
        }
        Value::Array(items) => Value::Array(items.into_iter().map(whole_numbers).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, whole_numbers(value)))
                .collect(),
        ),
        other => other,
    }
}

/// A value as JSON, with numbers as JavaScript writes them.
pub fn to_value<T: Serialize + ?Sized>(value: &T) -> Value {
    whole_numbers(serde_json::to_value(value).unwrap_or(Value::Null))
}

// ── dates ───────────────────────────────────────────────────────────────────

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number: (year, month, day).
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `new Date(Date.UTC(year, month, 0)).getUTCDate()`: the last day of
/// `month` (1-based); month 0 is December of the year before.
pub fn last_day_of_month(year: i64, month: i64) -> i64 {
    let first_of_next = days_from_civil(year, 1, 1) + month_offset(year, month);
    civil_from_days(first_of_next - 1).2
}

/// Days from 1 January of `year` to the first of the month after `month`
/// (1-based, may overflow into later years).
fn month_offset(year: i64, month: i64) -> i64 {
    let total = year * 12 + month;
    let (y, m) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    days_from_civil(y, m, 1) - days_from_civil(year, 1, 1)
}

/// `YYYY-MM-DD` of a day number, as `toISOString().slice(0, 10)`.
pub fn format_days(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    if (0..=9999).contains(&y) {
        format!("{y:04}-{m:02}-{d:02}")
    } else if y < 0 {
        format!("-{:06}-{m:02}-{d:02}", -y)
    } else {
        format!("+{y:06}-{m:02}-{d:02}")
    }
}

/// `new Date(`${iso}T00:00:00Z`)` after a `/^\d{4}-\d{2}-\d{2}$/` check:
/// days past the month's end roll over, as in JavaScript; month 13 or day
/// 32 is an invalid date.
pub fn parse_days(iso: &str) -> Result<i64, PayrollError> {
    let bytes = iso.as_bytes();
    let shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !shape {
        return Err(PayrollError::new(format!("Not a date: {iso}")));
    }
    let num = |range: std::ops::Range<usize>| iso[range].parse::<i64>().unwrap_or(0);
    let (year, month, day) = (num(0..4), num(5..7), num(8..10));
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(PayrollError::new("Invalid time value"));
    }
    Ok(days_from_civil(year, month, 1) + day - 1)
}

/// `getUTCDay()` of a day number: 0 = Sunday.
pub fn weekday_of(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

/// `iso.slice(a, b)` on an ASCII date string, clamped like `slice`.
pub fn slice(text: &str, start: usize, end: usize) -> &str {
    let len = text.len();
    let (s, e) = (start.min(len), end.min(len));
    if s >= e {
        ""
    } else {
        text.get(s..e).unwrap_or("")
    }
}

/// `Number(text)` of a slice that holds digits.
pub fn int_of(text: &str) -> i64 {
    text.parse::<i64>().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers() {
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(-0.001, 2), "-0.00");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
        assert_eq!(number_text(1e21), "1e+21");
        assert_eq!(number_text(0.1 + 0.2), "0.30000000000000004");
        assert!((math_round(-2.5) + 2.0).abs() < f64::EPSILON);
        assert!((math_round(2.5) - 3.0).abs() < f64::EPSILON);
        assert!(number_of("12abc").is_nan());
        assert!((number_of(" 1e3 ") - 1000.0).abs() < f64::EPSILON);
    }

    #[test]
    fn dates() {
        assert_eq!(
            format_days(parse_days("2026-02-30").unwrap_or(0)),
            "2026-03-02"
        );
        assert!(parse_days("2026-02-32").is_err());
        assert_eq!(last_day_of_month(2026, 2), 28);
        assert_eq!(last_day_of_month(2024, 2), 29);
        assert_eq!(last_day_of_month(2026, 0), 31);
        assert_eq!(weekday_of(parse_days("2026-11-01").unwrap_or(0)), 0);
    }
}
