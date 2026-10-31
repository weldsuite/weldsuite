//! Amounts in cents (`money.ts`). Cents are JavaScript numbers in the
//! TypeScript engines, so they are `f64` here and every operation mirrors
//! the JavaScript one.

use crate::PayrollError;
use crate::js::{number_of, number_text, trunc};

pub type Cents = f64;

/// `toCents(number)`: euros/dollars to cents, half away from zero.
pub fn to_cents(value: f64) -> Cents {
    round_half_away_from_zero(value * 100.0)
}

/// `toCents(value)` for a value that may be text (a `numeric` column),
/// null or empty (0). Not a number is an error, as the TypeScript throws.
pub fn to_cents_text(value: Option<&str>) -> Result<Cents, PayrollError> {
    match value {
        None | Some("") => Ok(0.0),
        Some(text) => {
            let n = number_of(text);
            if n.is_finite() {
                Ok(to_cents(n))
            } else {
                Err(PayrollError::new(format!("Not an amount: {text}")))
            }
        }
    }
}

/// `fromCents(cents)`: `"-12.34"`.
pub fn from_cents(cents: Cents) -> String {
    let sign = if cents < 0.0 { "-" } else { "" };
    let abs = trunc(cents).abs();
    let whole = (abs / 100.0).floor();
    let rest = abs % 100.0;
    format!("{sign}{}.{:0>2}", number_text(whole), number_text(rest))
}

/// `roundHalfAwayFromZero(n)`, with the TypeScript's 1e-9 nudge.
pub fn round_half_away_from_zero(n: f64) -> f64 {
    if n >= 0.0 {
        (n + 0.5 + 1e-9).floor()
    } else {
        -(-n + 0.5 + 1e-9).floor()
    }
}

/// `floorCents(n)`.
pub fn floor_cents(n: f64) -> Cents {
    if n >= 0.0 {
        (n + 1e-9).floor()
    } else {
        -(-n - 1e-9).ceil()
    }
}

/// `floorToUnit(cents)`: down to whole euros/dollars.
pub fn floor_to_unit(cents: Cents) -> Cents {
    (cents / 100.0 + 1e-9).floor() * 100.0
}

/// `percentOf(cents, ratePercent)`.
pub fn percent_of(cents: Cents, rate_percent: f64) -> Cents {
    round_half_away_from_zero((cents * rate_percent) / 100.0)
}

/// `sum(values)`.
pub fn sum<I: IntoIterator<Item = Cents>>(values: I) -> Cents {
    values.into_iter().fold(0.0, |total, v| total + v)
}

/// `clamp(cents, min, max)`: `Math.min(Math.max(cents, min), max)`.
pub fn clamp(cents: Cents, min: Cents, max: Cents) -> Cents {
    js_min(js_max(cents, min), max)
}

/// `Math.min(a, b)` (NaN wins, as in JavaScript).
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `Math.max(a, b)` (NaN wins, as in JavaScript).
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cents() {
        assert_eq!(from_cents(-1234.0), "-12.34");
        assert_eq!(from_cents(5.0), "0.05");
        assert!((to_cents(1.005) - 101.0).abs() < f64::EPSILON);
        assert!((round_half_away_from_zero(-2.5) + 3.0).abs() < f64::EPSILON);
        assert!(to_cents_text(Some("abc")).is_err());
    }
}
