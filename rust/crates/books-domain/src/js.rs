//! JavaScript's semantics where WeldBooks' TypeScript depends on them: how
//! `new Date(text)` parses, how numbers print (`String(n)`, `toFixed`),
//! `Math.round`, `Number.parseInt`, and the posting service's money
//! rounding (`roundMoney`).

use serde_json::{Value, json};

/// `Number.EPSILON`.
pub const EPSILON: f64 = f64::EPSILON;

/// `roundMoney(value)`: `Math.round((value + Number.EPSILON) * 100) / 100`.
pub fn round_money(value: f64) -> f64 {
    math_round((value + EPSILON) * 100.0) / 100.0
}

/// `Math.round(x * 100) / 100` (no epsilon), as `toBaseCurrency` rounds.
pub fn round_cents(value: f64) -> f64 {
    math_round(value * 100.0) / 100.0
}

/// A `numeric` column's text as JavaScript's `Number(text ?? 0)` reads it;
/// `None`/null is 0.
pub fn numeric_text(text: Option<&str>) -> f64 {
    text.map_or(0.0, weldsuite_kit::validation::js_number)
}

/// `new Date(text)` for the ISO forms JavaScript parses: a date (`2026`,
/// `2026-03`, `2026-03-04`, or a six-digit signed year), optionally a time
/// (`T`, `t` or a space; `HH:mm`, seconds, a fraction) and an offset (`Z`,
/// `±HH:mm`, `±HHmm`). Days past the end of the month roll over, as in
/// JavaScript. A time without an offset is UTC, the Workers' local time.
/// Other forms (V8's legacy parser) are not read: `None`, an invalid date.
/// The answer is `toISOString()`.
pub fn js_date(text: &str) -> Option<String> {
    js_date_millis(text).and_then(iso_from_millis)
}

/// `new Date(text).getTime()` for the forms [`js_date`] reads.
pub fn js_date_millis(text: &str) -> Option<i64> {
    let mut p = Cursor {
        bytes: text.as_bytes(),
        at: 0,
    };
    let year = match p.peek() {
        Some(sign @ (b'+' | b'-')) => {
            p.at += 1;
            let digits = p.digits(6, 6)?;
            if sign == b'-' && digits == 0 {
                return None;
            }
            if sign == b'-' { -digits } else { digits }
        }
        _ => p.digits(4, 4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if p.eat(b'-') {
        month = p.digits(2, 2)?;
        if p.eat(b'-') {
            day = p.digits(2, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut millis_of_day = 0;
    let mut offset_minutes = 0;
    if matches!(p.peek(), Some(b'T' | b't' | b' ')) {
        p.at += 1;
        let hour = p.digits(2, 2)?;
        if !p.eat(b':') {
            return None;
        }
        let minute = p.digits(2, 2)?;
        let mut second = 0;
        let mut millis = 0;
        if p.eat(b':') {
            second = p.digits(2, 2)?;
            if p.eat(b'.') {
                let start = p.at;
                while p.peek().is_some_and(|b| b.is_ascii_digit()) {
                    p.at += 1;
                }
                let fraction = &text[start..p.at];
                if fraction.is_empty() {
                    return None;
                }
                let padded: String = fraction.chars().chain("000".chars()).take(3).collect();
                millis = padded.parse::<i64>().ok()?;
            }
        }
        if hour > 24
            || minute > 59
            || second > 59
            || (hour == 24 && (minute, second, millis) != (0, 0, 0))
        {
            return None;
        }
        millis_of_day = ((hour * 60 + minute) * 60 + second) * 1000 + millis;
        match p.peek() {
            Some(b'Z' | b'z') => p.at += 1,
            Some(sign @ (b'+' | b'-')) => {
                p.at += 1;
                let hours = p.digits(2, 2)?;
                p.eat(b':');
                let minutes = p.digits(2, 2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                let total = hours * 60 + minutes;
                offset_minutes = if sign == b'-' { -total } else { total };
            }
            _ => {}
        }
    }
    if p.at != text.len() {
        return None;
    }
    let days = days_from_civil(year, month, 1) + day - 1;
    let epoch_millis = days * 86_400_000 + millis_of_day - offset_minutes * 60_000;
    // `toISOString()` throws past ±8.64e15 ms.
    if epoch_millis.abs() > 8_640_000_000_000_000 {
        return None;
    }
    Some(epoch_millis)
}

/// `new Date(millis).toISOString()`.
pub fn iso_from_millis(millis: i64) -> Option<String> {
    let at =
        time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()?;
    Some(weldsuite_events::iso_timestamp(at))
}

/// Milliseconds since the epoch of an ISO timestamp as the rows hold it.
pub fn millis_of(iso: &str) -> Option<i64> {
    js_date_millis(iso)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn digits(&mut self, min: usize, max: usize) -> Option<i64> {
        let start = self.at;
        while self.at - start < max && self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.at += 1;
        }
        if self.at - start < min {
            return None;
        }
        std::str::from_utf8(&self.bytes[start..self.at])
            .ok()?
            .parse()
            .ok()
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `(year, month, day)` of a day count since 1970-01-01 (`civil_from_days`).
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
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

/// `Math.round(number)`: halves go up.
pub fn math_round(number: f64) -> f64 {
    (number + 0.5).floor()
}

/// `number.toFixed(digits)`: the exact decimal value rounded half away
/// from zero (JavaScript picks the larger `n` on a tie), unlike Rust's
/// formatter, which rounds a tie to even.
pub fn to_fixed(number: f64, digits: usize) -> String {
    if !number.is_finite() {
        return number_text(number);
    }
    if number.abs() >= 1e21 {
        return number_text(number);
    }
    let negative = number < 0.0;
    // The exact decimal expansion: a double below 1e21 has at most 1074
    // fractional binary digits, but anything this API rounds is far larger
    // than 2^-60, so 80 decimal places hold it exactly.
    let exact = format!("{:.80}", number.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let kept = &fraction[..digits.min(fraction.len())];
    let rest = &fraction[digits.min(fraction.len())..];
    let round_up = rest.as_bytes().first().is_some_and(|d| *d >= b'5');
    let mut digits_vec: Vec<u8> = whole.bytes().chain(kept.bytes()).collect();
    if round_up {
        let mut i = digits_vec.len();
        loop {
            if i == 0 {
                digits_vec.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits_vec[i] == b'9' {
                digits_vec[i] = b'0';
            } else {
                digits_vec[i] += 1;
                break;
            }
        }
    }
    let split = digits_vec.len() - digits;
    let int_part = String::from_utf8_lossy(&digits_vec[..split]).into_owned();
    let frac_part = String::from_utf8_lossy(&digits_vec[split..]).into_owned();
    let mut out = String::new();
    // `(-0.001).toFixed(2)` is `-0.00`: the sign is the number's, not the
    // rounded digits'.
    if negative {
        out.push('-');
    }
    out.push_str(&int_part);
    if digits > 0 {
        out.push('.');
        out.push_str(&frac_part);
    }
    out
}

/// `Number(text)` for a numeric column's text (`"12.50"`), `0` when null.
pub fn numeric(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(text) => weldsuite_kit::validation::js_number(text),
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        _ => 0.0,
    }
}

/// `Number(value)` as JavaScript reads any JSON value (`null` is 0, an
/// absent value NaN, an object NaN).
pub fn js_number_value(value: Option<&Value>) -> f64 {
    weldsuite_kit::validation::js_number_of(value)
}

/// `Number.parseInt(text, 10)`: leading whitespace, a sign, then as many
/// digits as there are; `None` (NaN) without any.
pub fn parse_int(text: &str) -> Option<i64> {
    let text = weldsuite_kit::validation::js_trim(text);
    let (negative, rest) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let value = digits.parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

/// `Number.parseFloat(text)`: leading whitespace, then the longest prefix
/// that is a decimal literal (sign, digits, one dot, an exponent) or
/// `Infinity`; NaN without one.
pub fn parse_float(text: &str) -> f64 {
    let text = weldsuite_kit::validation::js_trim(text);
    let bytes = text.as_bytes();
    let mut at = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        at = 1;
    }
    if text[at..].starts_with("Infinity") {
        return if bytes.first() == Some(&b'-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let digits_start = at;
    while bytes.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
    }
    let mut mantissa_digits = at - digits_start;
    if bytes.get(at) == Some(&b'.') {
        let dot = at;
        at += 1;
        let fraction_start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        mantissa_digits += at - fraction_start;
        if at == fraction_start && mantissa_digits == 0 {
            at = dot;
        }
    }
    if mantissa_digits == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        let mut exp = at + 1;
        if matches!(bytes.get(exp), Some(b'+' | b'-')) {
            exp += 1;
        }
        let exp_digits = exp;
        while bytes.get(exp).is_some_and(u8::is_ascii_digit) {
            exp += 1;
        }
        if exp > exp_digits {
            at = exp;
        }
    }
    let literal = text[..at].trim_end_matches('.');
    literal.parse::<f64>().unwrap_or(f64::NAN)
}

/// `a.localeCompare(b)`: ICU's root collation, as Node's default locale
/// sorts.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use icu_collator::options::CollatorOptions;
    use icu_collator::{CollatorBorrowed, CollatorPreferences};
    static COLLATOR: std::sync::LazyLock<Option<CollatorBorrowed<'static>>> =
        std::sync::LazyLock::new(|| {
            CollatorBorrowed::try_new(CollatorPreferences::default(), CollatorOptions::default())
                .ok()
        });
    COLLATOR
        .as_ref()
        .map_or_else(|| a.cmp(b), |collator| collator.compare(a, b))
}

/// `text.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, max)` in UTF-16 units. A surrogate pair cut in half leaves
/// a lone surrogate, which becomes U+FFFD on its way to the database.
pub fn slice_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        let width = c.len_utf16();
        if units + width > max {
            if units < max {
                out.push('\u{fffd}');
            }
            break;
        }
        units += width;
        out.push(c);
    }
    out
}

/// `%term%` for an ILIKE "contains" match, with the user's wildcards
/// (`%`, `_`) and the escape character escaped (`containsPattern`).
pub fn contains_pattern(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 2);
    out.push('%');
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// JavaScript truthiness of a JSON value (`undefined` is `None`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_ties_up() {
        assert_eq!(to_fixed(3.125, 2), "3.13");
        assert_eq!(to_fixed(0.0, 2), "0.00");
        assert_eq!(to_fixed(37.5, 2), "37.50");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(99.995, 2), "100.00");
        assert_eq!(to_fixed(-1.5, 0), "-2");
        assert_eq!(to_fixed(66.666_666_666, 2), "66.67");
        assert_eq!(to_fixed(-0.001, 2), "-0.00");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
    }

    #[test]
    fn dates_parse_like_javascript() {
        assert_eq!(
            js_date("2026-03-04").as_deref(),
            Some("2026-03-04T00:00:00.000Z")
        );
        assert_eq!(
            js_date("2026-03-04T10:00+01:00").as_deref(),
            Some("2026-03-04T09:00:00.000Z")
        );
        assert_eq!(js_date("nope"), None);
        assert_eq!(civil_from_days(days_from_civil(2026, 2, 28)), (2026, 2, 28));
    }

    #[test]
    fn like_patterns_escape_wildcards() {
        assert_eq!(contains_pattern("50%_a\\"), "%50\\%\\_a\\\\%");
    }
}
